//! An automation's first check (PRO-484): a cheap shell command run before any
//! session is created, so a run with nothing new to do costs no model call.
//!
//! - Exit 0 and nothing printed (after trimming): the run ends as
//!   [`AutomationRunStatus::SkippedPrecheck`], "nothing new".
//! - Exit 0 and something printed: the run goes ahead, and what was printed is
//!   given to the agent under its own heading after the automation's prompt.
//! - Any other exit, a timeout, or a command that cannot start: a failed run
//!   with the reason. Never a silent skip, never a model call.
//!
//! The command runs through `/bin/sh -c` in the folder the run would use
//! (never a new worktree), with the environment overrides an automation
//! session gets.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::{
    emit_run, update_summary, Automation, AutomationHost, AutomationPrecheck,
    AutomationPrecheckResult, AutomationRun, AutomationRunStatus, AutomationWorkspace,
};
use crate::store::{automations as automation_store, index};

/// The timeout a check gets when none (or zero) is saved.
pub const DEFAULT_TIMEOUT_SECONDS: u32 = 60;
/// The longest a check may run. Checks are meant to be cheap, and the
/// scheduler waits for them.
pub const MAX_TIMEOUT_SECONDS: u32 = 300;
/// What is kept of standard output: the start, which is what the agent reads.
const STDOUT_CAP: usize = 32 * 1024;
/// What is kept of standard error, for a failed check's explanation.
const STDERR_CAP: usize = 8 * 1024;
/// How long to wait for output a process left behind after the check ended.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrecheckOutcome {
    /// Exit 0 with no output: skip the run.
    NothingNew,
    /// Exit 0 with output: run the agent with that output.
    Proceed,
    /// A non-zero exit, a timeout or a command that could not start.
    Failed,
}

/// One execution of a check, as the editor's Try it button shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckTrial {
    pub outcome: PrecheckOutcome,
    /// Why a failed check failed. Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub result: AutomationPrecheckResult,
}

/// What the editor sends to try a check before it is saved.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckTryInput {
    pub project_path: String,
    pub workspace: AutomationWorkspace,
    #[serde(default)]
    pub session_id: Option<String>,
    pub precheck: AutomationPrecheck,
}

/// The saved timeout, with the default for zero and the cap applied.
pub fn timeout_seconds(configured: u32) -> u32 {
    if configured == 0 {
        DEFAULT_TIMEOUT_SECONDS
    } else {
        configured.min(MAX_TIMEOUT_SECONDS)
    }
}

/// The check as saved: a blank command is no check, and the timeout gets
/// its default and cap.
pub fn normalized(precheck: Option<AutomationPrecheck>) -> Option<AutomationPrecheck> {
    let precheck = precheck?;
    let command = precheck.command.trim();
    (!command.is_empty()).then(|| AutomationPrecheck {
        command: command.to_string(),
        timeout_seconds: timeout_seconds(precheck.timeout_seconds),
    })
}

/// A saved check only counts when it names a command.
fn configured(precheck: Option<&AutomationPrecheck>) -> Option<&AutomationPrecheck> {
    precheck.filter(|value| !value.command.trim().is_empty())
}

#[derive(Default)]
struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}

/// Read a pipe to its end on a thread of its own, keeping at most `cap`
/// bytes. The rest is read and dropped so the check never blocks on a full
/// pipe. The receiver hears once the pipe has closed.
fn capture(pipe: Option<impl Read + Send + 'static>, cap: usize) -> (Arc<Mutex<Captured>>, mpsc::Receiver<()>) {
    let captured = Arc::new(Mutex::new(Captured::default()));
    let (done, finished) = mpsc::channel();
    let Some(mut pipe) = pipe else {
        let _ = done.send(());
        return (captured, finished);
    };
    let target = captured.clone();
    // Should no thread start, the pipe closes with the closure and the check
    // sees a closed pipe if it writes.
    let _ = std::thread::Builder::new().name("automation-precheck-output".into()).spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let mut captured = target.lock().unwrap_or_else(|error| error.into_inner());
                    let room = cap.saturating_sub(captured.bytes.len());
                    captured.bytes.extend_from_slice(&chunk[..read.min(room)]);
                    if read > room {
                        captured.truncated = true;
                    }
                }
            }
        }
        let _ = done.send(());
    });
    (captured, finished)
}

fn take(captured: &Arc<Mutex<Captured>>) -> (String, bool) {
    let captured = captured.lock().unwrap_or_else(|error| error.into_inner());
    (String::from_utf8_lossy(&captured.bytes).into_owned(), captured.truncated)
}

/// Whether the check's shell has exited, without reaping it.
#[cfg(unix)]
fn exited(child: &mut std::process::Child) -> std::io::Result<bool> {
    let pid = libc::id_t::from(child.id());
    // SAFETY: a zeroed siginfo_t is a valid out-parameter for waitid(2).
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: WNOWAIT leaves the child waitable; WNOHANG returns at once.
    let result = unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
    if result == -1 {
        return Err(std::io::Error::last_os_error());
    }
    // With WNOHANG and no change, nothing is filled in: si_signo stays 0.
    Ok(info.si_signo != 0)
}

#[cfg(not(unix))]
fn exited(child: &mut std::process::Child) -> std::io::Result<bool> {
    child.try_wait().map(|status| status.is_some())
}

/// End the check and anything it started in the background. Called while
/// the shell is still unreaped.
fn stop(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // The check leads its own process group (see `execute`).
        if let Ok(pid) = libc::pid_t::try_from(child.id()) {
            // SAFETY: kill(2) with a negative pid signals that process group only.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
}

/// Run `command` once through `/bin/sh` in `dir` with `env` added to this
/// process's environment, and say what an automation run would do.
pub fn execute(command: &str, timeout: Duration, dir: &Path, env: &BTreeMap<String, String>) -> PrecheckTrial {
    let started = Instant::now();
    let mut process = Command::new("/bin/sh");
    process
        .arg("-c")
        .arg(command)
        .current_dir(dir)
        // An agent session's PATH: an app opened from the Finder inherits
        // launchd's, where `gh` and friends are not found. Overrides win.
        .env("PATH", crate::binpath::login_path())
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            return PrecheckTrial {
                outcome: PrecheckOutcome::Failed,
                reason: Some(format!("The first check could not start in {}: {error}", dir.display())),
                result: AutomationPrecheckResult {
                    exit_code: None,
                    stdout_tail: String::new(),
                    stderr_tail: String::new(),
                    truncated: false,
                    timed_out: false,
                    duration_ms: started.elapsed().as_millis() as u64,
                },
            };
        }
    };
    let (stdout, stdout_done) = capture(child.stdout.take(), STDOUT_CAP);
    let (stderr, stderr_done) = capture(child.stderr.take(), STDERR_CAP);
    let deadline = started + timeout;
    let mut timed_out = false;
    // The shell is reaped only after its process group has been signalled:
    // until then its pid, and so the group's id, cannot belong to anyone else.
    let status = loop {
        match exited(&mut child) {
            Ok(true) => {
                // A process the check left running in the background would
                // hold its output open (and outlive the check); end it too.
                stop(&mut child);
                break child.wait().ok();
            }
            Ok(false) if Instant::now() >= deadline => {
                timed_out = true;
                stop(&mut child);
                let _ = child.wait();
                break None;
            }
            Ok(false) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                stop(&mut child);
                let _ = child.wait();
                break None;
            }
        }
    };
    let drain_until = Instant::now() + DRAIN_GRACE;
    for finished in [&stdout_done, &stderr_done] {
        let _ = finished.recv_timeout(drain_until.saturating_duration_since(Instant::now()));
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    let (stdout, stdout_truncated) = take(&stdout);
    let (stderr, stderr_truncated) = take(&stderr);
    let exit_code = status.and_then(|status| status.code());
    let (outcome, reason) = if timed_out {
        (PrecheckOutcome::Failed, Some(format!("The first check did not finish within {} seconds.", timeout.as_secs())))
    } else {
        match (status, exit_code) {
            (Some(_), Some(0)) if stdout.trim().is_empty() => (PrecheckOutcome::NothingNew, None),
            (Some(_), Some(0)) => (PrecheckOutcome::Proceed, None),
            (Some(_), Some(code)) => (PrecheckOutcome::Failed, Some(format!("The first check exited with status {code}."))),
            (Some(_), None) => (PrecheckOutcome::Failed, Some("The first check was stopped by a signal.".into())),
            (None, _) => (PrecheckOutcome::Failed, Some("The first check's process could not be waited on.".into())),
        }
    };
    PrecheckTrial {
        outcome,
        reason,
        result: AutomationPrecheckResult {
            exit_code,
            stdout_tail: stdout,
            stderr_tail: stderr,
            truncated: stdout_truncated || stderr_truncated,
            timed_out,
            duration_ms,
        },
    }
}

/// The folder a run would use: the target session's for an existing-session
/// automation, the project's otherwise (a run's new worktree does not exist yet).
fn folder(project_path: &str, workspace: AutomationWorkspace, session_id: Option<&str>) -> Result<String> {
    match workspace {
        AutomationWorkspace::NewWorktree => Ok(project_path.to_string()),
        AutomationWorkspace::Session => Ok(index::get(session_id.context("automation has no target session")?)?.cwd),
    }
}

/// The environment an automation session gets, applied the same way: a
/// missing configuration is an error, never a different set of variables.
fn environment(dir: &str) -> Result<BTreeMap<String, String>> {
    crate::store::environment::prepare_unattended(dir, None)?;
    let launch = crate::store::environment::launch(dir)?;
    launch.require_available()?;
    Ok(launch.values)
}

fn run_in(project_path: &str, workspace: AutomationWorkspace, session_id: Option<&str>, precheck: &AutomationPrecheck) -> Result<PrecheckTrial> {
    let dir = folder(project_path, workspace, session_id)?;
    let env = environment(&dir)?;
    let timeout = Duration::from_secs(u64::from(timeout_seconds(precheck.timeout_seconds)));
    Ok(execute(&precheck.command, timeout, Path::new(&dir), &env))
}

/// The editor's Try it: run the check once, exactly as a run would, and say
/// what the run would have done. Nothing is recorded.
pub fn try_precheck(input: PrecheckTryInput) -> Result<PrecheckTrial> {
    anyhow::ensure!(!input.precheck.command.trim().is_empty(), "Enter a command to try.");
    let project_path = crate::store::projects::canonical(&input.project_path)?;
    run_in(&project_path, input.workspace, input.session_id.as_deref(), &input.precheck)
}

/// The prompt the agent receives when the check printed something.
pub fn prompt_with_output(prompt: &str, command: &str, output: &str, truncated: bool) -> String {
    let longest_backticks = output
        .split(|ch| ch != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest_backticks.max(2) + 1);
    let note = if truncated { "\n\n(The output was cut short; only its start is shown.)" } else { "" };
    format!(
        "{prompt}\n\n## Output of this automation's first check\n\nBefore this run, the command `{}` ran in this project and printed:\n\n{fence}\n{}\n{fence}{note}",
        command.trim().replace('`', "'"),
        output.trim_end(),
    )
}

/// Run `precheck` for `automation` as a run would. A check that cannot be
/// run at all (no folder, no environment) is a failed check.
fn check(automation: &Automation, precheck: &AutomationPrecheck) -> PrecheckTrial {
    run_in(&automation.project_path, automation.workspace, automation.session_id.as_deref(), precheck)
        .unwrap_or_else(|error| PrecheckTrial {
            outcome: PrecheckOutcome::Failed,
            reason: Some(format!("The first check could not run: {error:#}")),
            result: AutomationPrecheckResult {
                exit_code: None,
                stdout_tail: String::new(),
                stderr_tail: String::new(),
                truncated: false,
                timed_out: false,
                duration_ms: 0,
            },
        })
}

/// One issue poll runs its automation's check once, for all the issues it
/// starts runs for: the first run's check is reused by the rest.
struct PollMemo {
    automation_id: String,
    trial: Option<PrecheckTrial>,
}

thread_local! {
    static POLL: std::cell::RefCell<Option<PollMemo>> = const { std::cell::RefCell::new(None) };
}

/// The automations being evaluated on threads of their own.
static APART: Mutex<std::collections::BTreeSet<String>> = Mutex::new(std::collections::BTreeSet::new());

/// Evaluate an automation that has a first check on a thread of its own, so
/// a slow check never holds up the scheduler or the other automations; its
/// next tick is skipped while one is still going. False, and nothing done,
/// for an automation without a check: the scheduler evaluates it in turn.
pub(super) fn evaluate_apart(app: &impl AutomationHost, automation: &Automation, now: chrono::DateTime<chrono::Utc>) -> bool {
    if configured(automation.precheck.as_ref()).is_none() {
        return false;
    }
    if !APART.lock().unwrap_or_else(|error| error.into_inner()).insert(automation.id.clone()) {
        return true;
    }
    let app = app.clone();
    let automation = automation.clone();
    let id = automation.id.clone();
    let spawned = std::thread::Builder::new().name("automation-precheck-run".into()).spawn(move || {
        if automation.issue_trigger.is_some() {
            POLL.with(|poll| *poll.borrow_mut() = Some(PollMemo { automation_id: automation.id.clone(), trial: None }));
        }
        if let Err(error) = super::evaluate_automation(&app, &automation, now) {
            log::warn!("automation {}: {error:#}", automation.id);
        }
        POLL.with(|poll| *poll.borrow_mut() = None);
        APART.lock().unwrap_or_else(|error| error.into_inner()).remove(&automation.id);
    });
    if let Err(error) = spawned {
        log::warn!("automation {id}: could not start its evaluation: {error}");
        APART.lock().unwrap_or_else(|error| error.into_inner()).remove(&id);
    }
    true
}

/// Run the automation's check, if it has one, for `run` (already pending).
/// Returns the prompt to send, with the check's output added, or `None` when
/// the run has ended here: "nothing new", or failed. Either way no session
/// is created and no model is called.
pub(super) fn gate(app: &impl AutomationHost, automation: &Automation, run: &mut AutomationRun, prompt: String) -> Result<Option<String>> {
    let Some(precheck) = configured(automation.precheck.as_ref()) else {
        return Ok(Some(prompt));
    };
    let trial = POLL.with(|poll| match &mut *poll.borrow_mut() {
        Some(PollMemo { automation_id, trial }) if *automation_id == automation.id => {
            trial.get_or_insert_with(|| check(automation, precheck)).clone()
        }
        _ => check(automation, precheck),
    });
    let next = match trial.outcome {
        PrecheckOutcome::Proceed => Some(prompt_with_output(&prompt, &precheck.command, &trial.result.stdout_tail, trial.result.truncated)),
        PrecheckOutcome::NothingNew | PrecheckOutcome::Failed => None,
    };
    *run = automation_store::replace_run(&automation.id, &run.run_id, |value| {
        value.precheck = Some(trial.result.clone());
        match trial.outcome {
            PrecheckOutcome::Proceed => {}
            PrecheckOutcome::NothingNew => {
                value.status = AutomationRunStatus::SkippedPrecheck;
                value.ended_at = Some(index::now());
            }
            PrecheckOutcome::Failed => {
                value.status = AutomationRunStatus::Failed;
                value.ended_at = Some(index::now());
                value.error = trial.reason.clone();
            }
        }
        Ok(())
    })?;
    emit_run(app, run);
    if next.is_none() {
        let ended_at = run.ended_at.clone().unwrap_or_else(index::now);
        update_summary(app, &automation.id, run.status, &ended_at);
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(command: &str, seconds: u64) -> PrecheckTrial {
        let dir = tempfile::tempdir().unwrap();
        execute(command, Duration::from_secs(seconds), dir.path(), &BTreeMap::new())
    }

    #[test]
    fn nothing_printed_and_exit_zero_is_nothing_new() {
        let trial = run("printf '  \\n\\t\\n'", 10);
        assert_eq!(trial.outcome, PrecheckOutcome::NothingNew);
        assert_eq!(trial.result.exit_code, Some(0));
        assert!(trial.reason.is_none());
    }

    #[test]
    fn output_and_exit_zero_goes_ahead_with_the_output() {
        let trial = run("echo 'issue 12 changed'; echo warning >&2", 10);
        assert_eq!(trial.outcome, PrecheckOutcome::Proceed);
        assert_eq!(trial.result.stdout_tail, "issue 12 changed\n");
        assert_eq!(trial.result.stderr_tail, "warning\n");
    }

    #[test]
    fn a_non_zero_exit_fails_even_with_output() {
        let trial = run("echo something; exit 3", 10);
        assert_eq!(trial.outcome, PrecheckOutcome::Failed);
        assert_eq!(trial.result.exit_code, Some(3));
        assert_eq!(trial.reason.as_deref(), Some("The first check exited with status 3."));
        assert_eq!(trial.result.stdout_tail, "something\n");
    }

    #[test]
    fn a_hanging_check_times_out_and_fails() {
        let started = Instant::now();
        let trial = run("echo started; sleep 30", 1);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(trial.outcome, PrecheckOutcome::Failed);
        assert!(trial.result.timed_out);
        assert_eq!(trial.result.exit_code, None);
        assert_eq!(trial.result.stdout_tail, "started\n");
        assert!(trial.reason.unwrap().contains("did not finish within 1 seconds"));
    }

    #[test]
    fn a_background_process_does_not_hold_the_check_open() {
        let started = Instant::now();
        let trial = run("sleep 30 & echo done", 10);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(trial.outcome, PrecheckOutcome::Proceed);
    }

    #[test]
    fn output_is_capped_and_marked_truncated() {
        let trial = run("head -c 100000 /dev/zero | tr '\\0' x", 10);
        assert_eq!(trial.outcome, PrecheckOutcome::Proceed);
        assert_eq!(trial.result.stdout_tail.len(), STDOUT_CAP);
        assert!(trial.result.truncated);
    }

    #[test]
    fn a_command_in_a_missing_folder_cannot_start_and_fails() {
        let trial = execute("true", Duration::from_secs(5), Path::new("/nonexistent/precheck-folder"), &BTreeMap::new());
        assert_eq!(trial.outcome, PrecheckOutcome::Failed);
        assert!(trial.reason.unwrap().contains("could not start"));
    }

    #[test]
    fn the_check_runs_in_its_folder_with_the_given_environment() {
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([("PRECHECK_PROBE".to_string(), "from-overrides".to_string())]);
        let trial = execute("pwd -P; echo \"$PRECHECK_PROBE\"", Duration::from_secs(5), dir.path(), &env);
        let expected = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(trial.result.stdout_tail, format!("{}\nfrom-overrides\n", expected.display()));
    }

    // The run paths: Run now, the scheduler (due and missed) and issues.

    use crate::automations::{dispatch, dispatch_issue, evaluate, AutomationTrigger};
    use crate::sink::EventSink;

    #[derive(Clone)]
    struct Host(Arc<crate::sink::BroadcastSink>);

    impl AutomationHost for Host {
        fn sink(&self) -> Arc<dyn EventSink> {
            self.0.clone()
        }
        fn sessions(&self) -> Result<crate::session::SessionManager> {
            anyhow::bail!("a run the first check ends asks for no session manager")
        }
    }

    fn host() -> Host {
        Host(Arc::new(crate::sink::BroadcastSink::new(64)))
    }

    /// An automation in `project` with `command` as its first check, saved.
    fn saved(project: &Path, command: Option<&str>, timeout_seconds: u32, next_run_at: &str) -> Automation {
        let automation: Automation = serde_json::from_value(serde_json::json!({
            "id": "auto-precheck", "name": "Duty", "enabled": true,
            "projectPath": project.to_string_lossy(), "harness": "codex", "prompt": "Look at what changed.",
            "workspace": "newWorktree",
            "schedule": { "kind": "preset", "preset": "hourly", "minute": 0, "timezone": "UTC", "dtstart": "2026-01-01T00:00:00Z" },
            "precheck": command.map(|command| serde_json::json!({ "command": command, "timeoutSeconds": timeout_seconds })),
            "nextRunAt": next_run_at, "created": "2026-01-01T00:00:00Z", "modified": "2026-01-01T00:00:00Z",
        }))
        .unwrap();
        automation_store::save(std::slice::from_ref(&automation)).unwrap();
        automation
    }

    fn only_run(automation: &Automation) -> AutomationRun {
        let mut runs = automation_store::list_runs(&automation.id).unwrap();
        assert_eq!(runs.len(), 1);
        runs.remove(0)
    }

    /// Wait for automations evaluated on threads of their own.
    fn settle() {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !APART.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "an automation's evaluation did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn no_sessions() -> bool {
        index::load().unwrap().is_empty()
    }

    #[test]
    fn run_now_with_nothing_new_logs_a_run_and_starts_no_session() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let automation = saved(project.path(), Some("test -d . && printf ''"), 30, "2099-01-01T00:00:00Z");
        let run = dispatch(&host(), &automation.id, AutomationTrigger::Manual, None).unwrap();
        assert_eq!(run.status, AutomationRunStatus::SkippedPrecheck);
        assert_eq!(run.trigger, AutomationTrigger::Manual);
        assert!(run.session_id.is_none() && run.error.is_none() && run.ended_at.is_some());
        assert_eq!(run.precheck.as_ref().unwrap().exit_code, Some(0));
        assert_eq!(only_run(&automation), run);
        assert_eq!(automation_store::get(&automation.id).unwrap().last_outcome, Some(AutomationRunStatus::SkippedPrecheck));
        assert!(no_sessions());
    }

    #[test]
    fn run_now_with_a_failing_check_is_a_failed_run_without_a_session() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let automation = saved(project.path(), Some("echo 'gh: not logged in' >&2; exit 4"), 30, "2099-01-01T00:00:00Z");
        let run = dispatch(&host(), &automation.id, AutomationTrigger::Manual, None).unwrap();
        assert_eq!(run.status, AutomationRunStatus::Failed);
        assert_eq!(run.error.as_deref(), Some("The first check exited with status 4."));
        assert_eq!(run.precheck.as_ref().unwrap().stderr_tail, "gh: not logged in\n");
        assert!(run.session_id.is_none());
        assert!(no_sessions());
    }

    #[test]
    fn run_now_with_a_hanging_check_is_a_failed_run() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let automation = saved(project.path(), Some("sleep 30"), 1, "2099-01-01T00:00:00Z");
        let run = dispatch(&host(), &automation.id, AutomationTrigger::Manual, None).unwrap();
        assert_eq!(run.status, AutomationRunStatus::Failed);
        assert!(run.precheck.as_ref().unwrap().timed_out);
        assert!(run.error.unwrap().contains("did not finish"));
        assert!(no_sessions());
    }

    #[test]
    fn output_goes_ahead_with_the_output_in_the_prompt() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let automation = saved(project.path(), Some("echo 'PR #7 needs review'"), 30, "2099-01-01T00:00:00Z");
        let mut run = automation_store::insert_run(super::super::new_run(&automation.id, AutomationTrigger::Manual, None, AutomationRunStatus::Pending)).unwrap();
        let prompt = gate(&host(), &automation, &mut run, automation.prompt.clone()).unwrap().unwrap();
        assert!(prompt.starts_with("Look at what changed.\n\n## Output of this automation's first check"));
        assert!(prompt.contains("PR #7 needs review"));
        assert_eq!(run.status, AutomationRunStatus::Pending);
        assert_eq!(only_run(&automation).precheck.unwrap().stdout_tail, "PR #7 needs review\n");
    }

    #[test]
    fn an_automation_without_a_check_is_untouched() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        for command in [None, Some("   ")] {
            let automation = saved(project.path(), command, 30, "2099-01-01T00:00:00Z");
            let mut run = automation_store::insert_run(super::super::new_run(&automation.id, AutomationTrigger::Manual, None, AutomationRunStatus::Pending)).unwrap();
            let before = run.clone();
            assert_eq!(gate(&host(), &automation, &mut run, "Prompt".into()).unwrap().as_deref(), Some("Prompt"));
            assert_eq!(run, before);
            assert!(only_run(&automation).precheck.is_none());
            automation_store::remove(&automation.id).unwrap();
        }
    }

    #[test]
    fn a_due_scheduled_run_with_nothing_new_is_logged_as_nothing_new() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let due = (chrono::Utc::now() - chrono::TimeDelta::minutes(1)).to_rfc3339();
        let automation = saved(project.path(), Some("true"), 30, &due);
        evaluate(&host()).unwrap();
        settle();
        let run = only_run(&automation);
        assert_eq!(run.status, AutomationRunStatus::SkippedPrecheck);
        assert_eq!(run.trigger, AutomationTrigger::Scheduled);
        assert!(run.session_id.is_none());
        assert!(no_sessions());
    }

    #[test]
    fn a_missed_run_never_runs_the_check() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let marker = project.path().join("ran");
        let missed = (chrono::Utc::now() - chrono::TimeDelta::days(2)).to_rfc3339();
        let automation = saved(project.path(), Some("touch ran"), 30, &missed);
        evaluate(&host()).unwrap();
        settle();
        let run = only_run(&automation);
        assert_eq!(run.status, AutomationRunStatus::SkippedMissed);
        assert!(run.precheck.is_none());
        assert!(!marker.exists());
    }

    #[test]
    fn an_issue_run_with_nothing_new_is_skipped_and_still_marked_seen() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let mut automation = saved(project.path(), Some("true"), 30, "2099-01-01T00:00:00Z");
        automation.issue_trigger = Some(serde_json::from_value(serde_json::json!({
            "provider": "github", "repo": "acme/widgets", "query": "label:raccoon",
        })).unwrap());
        automation_store::save(std::slice::from_ref(&automation)).unwrap();
        let value: serde_json::Value = serde_json::from_str(include_str!("../fixtures/github_issue_list.json")).unwrap();
        let issue = crate::issues::parse_github_issues(&value).remove(0);
        let mut seen = automation_store::SeenState::default();
        let run = dispatch_issue(&host(), &automation, &issue, &mut seen).unwrap();
        assert_eq!(run.status, AutomationRunStatus::SkippedPrecheck);
        assert!(run.issue.is_some() && run.session_id.is_none() && run.reported.is_none());
        assert_eq!(seen.issues.len(), 1);
        assert!(no_sessions());
    }

    #[test]
    fn a_slow_check_does_not_hold_up_the_scheduler_or_start_twice() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let due = (chrono::Utc::now() - chrono::TimeDelta::minutes(1)).to_rfc3339();
        let automation = saved(project.path(), Some("sleep 2"), 30, &due);
        let started = Instant::now();
        evaluate(&host()).unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        // Due again while its check is still going: no second run.
        automation_store::update(&automation.id, |value| {
            value.next_run_at = due.clone();
            Ok(())
        })
        .unwrap();
        evaluate(&host()).unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        settle();
        assert_eq!(only_run(&automation).status, AutomationRunStatus::SkippedPrecheck);
    }

    #[test]
    fn an_issue_poll_runs_the_check_once_for_all_its_issues() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let mut automation = saved(project.path(), Some("echo ran >> checks"), 30, "2099-01-01T00:00:00Z");
        automation.issue_trigger = Some(serde_json::from_value(serde_json::json!({
            "provider": "github", "repo": "acme/widgets", "query": "label:raccoon",
        })).unwrap());
        automation_store::save(std::slice::from_ref(&automation)).unwrap();
        let value: serde_json::Value = serde_json::from_str(include_str!("../fixtures/github_issue_list.json")).unwrap();
        let issues = crate::issues::parse_github_issues(&value);
        assert!(issues.len() >= 2);
        let mut seen = automation_store::SeenState::default();
        POLL.with(|poll| *poll.borrow_mut() = Some(PollMemo { automation_id: automation.id.clone(), trial: None }));
        for issue in &issues[..2] {
            let run = dispatch_issue(&host(), &automation, issue, &mut seen).unwrap();
            assert_eq!(run.status, AutomationRunStatus::SkippedPrecheck);
        }
        POLL.with(|poll| *poll.borrow_mut() = None);
        assert_eq!(std::fs::read_to_string(project.path().join("checks")).unwrap(), "ran\n");
    }

    #[test]
    fn the_check_gets_the_login_path_and_overrides_still_win() {
        let trial = run("printf %s \"$PATH\"", 10);
        assert_eq!(trial.result.stdout_tail, crate::binpath::login_path());
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        let trial = execute("printf %s \"$PATH\"", Duration::from_secs(5), dir.path(), &env);
        assert_eq!(trial.result.stdout_tail, "/usr/bin:/bin");
    }

    #[test]
    fn saving_trims_the_command_and_applies_the_timeout_rules() {
        assert_eq!(normalized(None), None);
        assert_eq!(normalized(Some(AutomationPrecheck { command: "  ".into(), timeout_seconds: 5 })), None);
        assert_eq!(
            normalized(Some(AutomationPrecheck { command: " gh pr list \n".into(), timeout_seconds: 0 })),
            Some(AutomationPrecheck { command: "gh pr list".into(), timeout_seconds: DEFAULT_TIMEOUT_SECONDS }),
        );
    }

    #[test]
    fn timeouts_default_and_are_capped() {
        assert_eq!(timeout_seconds(0), DEFAULT_TIMEOUT_SECONDS);
        assert_eq!(timeout_seconds(5), 5);
        assert_eq!(timeout_seconds(100_000), MAX_TIMEOUT_SECONDS);
    }

    #[test]
    fn the_prompt_carries_the_output_under_its_own_heading() {
        let prompt = prompt_with_output("Triage.", "gh issue list", "a ``` b\n", true);
        assert!(prompt.starts_with("Triage.\n\n## Output of this automation's first check\n"));
        assert!(prompt.contains("`gh issue list`"));
        assert!(prompt.contains("````\na ``` b\n````"));
        assert!(prompt.ends_with("only its start is shown.)"));
    }
}
