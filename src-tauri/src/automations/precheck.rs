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
//! (never a new worktree), with the environment a session pane gets
//! ([`crate::pty::session_environment`]).
//!
//! An issue automation's check gates its poll: it runs once, only when the
//! poll found issues to start, and a quiet or failing check starts none and
//! marks none as seen. Consecutive identical results (nothing new, or the same
//! failure) fold into one history record with a repeat count, so a frequent
//! check does not push real runs out of the history.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::{
    emit_run, update_summary, Automation, AutomationHost, AutomationPrecheck,
    AutomationPrecheckResult, AutomationRun, AutomationRunStatus, AutomationTrigger,
    AutomationWorkspace,
};
use crate::store::{automations as automation_store, index};

/// The timeout a check gets when none (or zero) is saved.
pub const DEFAULT_TIMEOUT_SECONDS: u32 = 60;
/// The longest a check may run. Checks are meant to be cheap.
pub const MAX_TIMEOUT_SECONDS: u32 = 300;
/// What is kept of standard output: the start, which is what the agent reads.
const STDOUT_CAP: usize = 32 * 1024;
/// What is kept of standard error, for a failed check's explanation.
const STDERR_CAP: usize = 8 * 1024;
/// How long to wait for output a process left behind after the check ended.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Serde's default for a saved check without a timeout.
pub fn default_timeout_seconds() -> u32 {
    DEFAULT_TIMEOUT_SECONDS
}

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

fn failed(reason: String, duration_ms: u64) -> PrecheckTrial {
    PrecheckTrial {
        outcome: PrecheckOutcome::Failed,
        reason: Some(reason),
        result: AutomationPrecheckResult {
            exit_code: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            truncated: false,
            timed_out: false,
            duration_ms,
        },
    }
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
/// pipe. With `skip_leading_whitespace`, whitespace before the first other
/// byte is not kept (nor counted against the cap). The receiver hears once
/// the pipe has closed. `None` when no thread could start.
fn capture(pipe: Option<impl Read + Send + 'static>, cap: usize, skip_leading_whitespace: bool) -> Option<(Arc<Mutex<Captured>>, mpsc::Receiver<()>)> {
    let captured = Arc::new(Mutex::new(Captured::default()));
    let (done, finished) = mpsc::channel();
    let Some(mut pipe) = pipe else {
        let _ = done.send(());
        return Some((captured, finished));
    };
    let target = captured.clone();
    std::thread::Builder::new()
        .name("automation-precheck-output".into())
        .spawn(move || {
            let mut chunk = [0u8; 8192];
            let mut leading = skip_leading_whitespace;
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let mut data = &chunk[..read];
                        if leading {
                            let start = data.iter().position(|byte| !byte.is_ascii_whitespace()).unwrap_or(data.len());
                            data = &data[start..];
                            leading = data.is_empty();
                        }
                        let mut captured = target.lock().unwrap_or_else(|error| error.into_inner());
                        let room = cap.saturating_sub(captured.bytes.len());
                        captured.bytes.extend_from_slice(&data[..data.len().min(room)]);
                        if data.len() > room {
                            captured.truncated = true;
                        }
                    }
                }
            }
            let _ = done.send(());
        })
        .ok()?;
    Some((captured, finished))
}

/// Where a UTF-8 text cut at an arbitrary byte stops being complete: the
/// start of a character whose bytes did not all fit.
fn complete_utf8_end(bytes: &[u8]) -> usize {
    for index in (bytes.len().saturating_sub(3)..bytes.len()).rev() {
        let byte = bytes[index];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let width = if byte >= 0xF0 { 4 } else if byte >= 0xE0 { 3 } else if byte >= 0xC0 { 2 } else { 1 };
        return if bytes.len() - index < width { index } else { bytes.len() };
    }
    bytes.len()
}

fn take(captured: &Arc<Mutex<Captured>>) -> (String, bool) {
    let captured = captured.lock().unwrap_or_else(|error| error.into_inner());
    let end = if captured.truncated { complete_utf8_end(&captured.bytes) } else { captured.bytes.len() };
    (String::from_utf8_lossy(&captured.bytes[..end]).into_owned(), captured.truncated)
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

/// Run `command` once through `/bin/sh` in `dir`, with `set` added to and
/// `unset` removed from this process's environment, and say what an
/// automation run would do.
pub fn execute(command: &str, timeout: Duration, dir: &Path, set: &[(String, String)], unset: &[&str]) -> PrecheckTrial {
    let started = Instant::now();
    let mut process = Command::new("/bin/sh");
    process
        .arg("-c")
        .arg(command)
        .current_dir(dir)
        .envs(set.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in unset {
        process.env_remove(name);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return failed(format!("The first check could not start in {}: {error}", dir.display()), started.elapsed().as_millis() as u64),
    };
    let stdout = capture(child.stdout.take(), STDOUT_CAP, true);
    let stderr = capture(child.stderr.take(), STDERR_CAP, false);
    let (Some((stdout, stdout_done)), Some((stderr, stderr_done))) = (stdout, stderr) else {
        // Unread output would look like none: never a silent "nothing new".
        stop(&mut child);
        let _ = child.wait();
        return failed("The first check's output could not be read.".into(), started.elapsed().as_millis() as u64);
    };
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

/// The environment a session pane gets, applied the same way: a missing
/// configuration is an error, never a different set of variables.
/// Variables to set, and names to remove, for a process started for a session.
type SessionEnvironment = (Vec<(String, String)>, &'static [&'static str]);

fn environment(dir: &str) -> Result<SessionEnvironment> {
    crate::store::environment::prepare_unattended(dir, None)?;
    let launch = crate::store::environment::launch(dir)?;
    launch.require_available()?;
    Ok(crate::pty::session_environment(&launch.values))
}

fn run_in(project_path: &str, workspace: AutomationWorkspace, session_id: Option<&str>, precheck: &AutomationPrecheck) -> Result<PrecheckTrial> {
    let dir = folder(project_path, workspace, session_id)?;
    let (set, unset) = environment(&dir)?;
    let timeout = Duration::from_secs(u64::from(timeout_seconds(precheck.timeout_seconds)));
    Ok(execute(&precheck.command, timeout, Path::new(&dir), &set, unset))
}

/// The editor's Try it: run the check once, exactly as a run would, and say
/// what the run would have done. Nothing is recorded.
pub fn try_precheck(input: PrecheckTryInput) -> Result<PrecheckTrial> {
    anyhow::ensure!(!input.precheck.command.trim().is_empty(), "Enter a command to try.");
    let project_path = crate::store::projects::canonical(&input.project_path)?;
    if input.workspace == AutomationWorkspace::Session {
        let target = index::get(input.session_id.as_deref().context("Choose a session for this automation.")?)?;
        anyhow::ensure!(crate::store::projects::canonical(&target.project_path)? == project_path, "The selected session belongs to another project.");
    }
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
        output.trim(),
    )
}

/// Run `precheck` for `automation` as a run would. A check that cannot be
/// run at all (no folder, no environment) is a failed check.
fn check(automation: &Automation, precheck: &AutomationPrecheck) -> PrecheckTrial {
    run_in(&automation.project_path, automation.workspace, automation.session_id.as_deref(), precheck)
        .unwrap_or_else(|error| failed(format!("The first check could not run: {error:#}"), 0))
}

#[cfg(test)]
static AGENT_MISSING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the automation's agent can run. When it cannot, the run reports
/// that (as it always has) and the check is not run: a quiet check must not
/// hide a missing agent.
fn agent_available(automation: &Automation) -> bool {
    #[cfg(test)]
    {
        let _ = automation;
        !AGENT_MISSING.load(std::sync::atomic::Ordering::SeqCst)
    }
    #[cfg(not(test))]
    crate::harness::offered().into_iter().any(|value| value.id == automation.harness && value.available)
}

/// An issue poll that went ahead hands its check's result to the runs it
/// starts, so the check runs once per poll.
struct PollMemo {
    automation_id: String,
    trial: PrecheckTrial,
}

thread_local! {
    static POLL: std::cell::RefCell<Option<PollMemo>> = const { std::cell::RefCell::new(None) };
}

/// The automations whose check is running (or about to), from the scheduler
/// or Run now: one at a time per automation.
static CHECKING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

struct Claim(String);

impl Claim {
    fn take(automation_id: &str) -> Option<Self> {
        CHECKING
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(automation_id.to_string())
            .then(|| Self(automation_id.to_string()))
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        CHECKING.lock().unwrap_or_else(|error| error.into_inner()).remove(&self.0);
    }
}

/// Evaluate an automation that has a first check on a thread of its own, so
/// a slow check never holds up the scheduler or the other automations; its
/// next tick is skipped while its check is still going. False, and nothing
/// done, for an automation without a check: the scheduler evaluates it in turn.
pub(super) fn evaluate_apart(app: &impl AutomationHost, automation: &Automation, now: chrono::DateTime<chrono::Utc>) -> bool {
    if configured(automation.precheck.as_ref()).is_none() {
        return false;
    }
    if !due(automation, now) {
        return true;
    }
    let Some(claim) = Claim::take(&automation.id) else {
        return true;
    };
    let id = automation.id.clone();
    let app = app.clone();
    let automation = automation.clone();
    let spawned = std::thread::Builder::new().name("automation-precheck-run".into()).spawn(move || {
        let _claim = claim;
        finishing(&app, &automation.id, || super::evaluate_automation(&app, &automation, now).map(|_| ()));
        POLL.with(|poll| *poll.borrow_mut() = None);
    });
    if let Err(error) = spawned {
        log::warn!("automation {id}: could not start its evaluation: {error}");
    }
    true
}

/// Whether the scheduler has anything to do for `automation` now: a due run
/// (or missed one to record), or an issue poll. Nothing is started otherwise.
fn due(automation: &Automation, now: chrono::DateTime<chrono::Utc>) -> bool {
    if automation.event_trigger.is_some() {
        return super::sources::due(automation, now);
    }
    match automation.issue_trigger.as_ref() {
        Some(trigger) => {
            automation.enabled && super::issue_poll_due(automation_store::load_seen(&automation.id).ok().flatten().as_ref(), trigger.poll_interval_minutes, now)
        }
        None => !matches!(super::due_action(automation, now), Ok(None)),
    }
}

/// Run `work` for `automation_id`, and fail any run of it that `work` left
/// pending without a session: a store error or a panic after the check must
/// not leave a run "Starting" until the next runtime start.
fn finishing(app: &impl AutomationHost, automation_id: &str, work: impl FnOnce() -> Result<()>) {
    let since = chrono::Utc::now() - chrono::TimeDelta::seconds(1);
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn!("automation {automation_id}: {error:#}"),
        Err(_) => log::warn!("automation {automation_id}: its run panicked"),
    }
    fail_orphans(app, automation_id, since);
}

fn fail_orphans(app: &impl AutomationHost, automation_id: &str, since: chrono::DateTime<chrono::Utc>) {
    let Ok(runs) = automation_store::list_runs(automation_id) else {
        return;
    };
    let started_since = |run: &AutomationRun| {
        run.started_at.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).is_some_and(|at| at >= since)
    };
    for orphan in runs.into_iter().filter(|run| run.status == AutomationRunStatus::Pending && run.session_id.is_none() && started_since(run)) {
        let Ok(run) = automation_store::replace_run(automation_id, &orphan.run_id, |value| {
            if value.status == AutomationRunStatus::Pending && value.session_id.is_none() {
                value.status = AutomationRunStatus::Failed;
                value.ended_at = Some(index::now());
                value.error = Some("The run stopped after its first check without starting.".into());
            }
            Ok(())
        }) else {
            continue;
        };
        emit_run(app, &run);
        let ended_at = run.ended_at.clone().unwrap_or_else(index::now);
        update_summary(app, automation_id, run.status, &ended_at);
    }
}

/// Whether an issue poll goes on to its next issue: not once the automation
/// was deleted or turned off, so the issues not yet started stay unseen.
pub(super) fn batch_goes_on(automation: &Automation) -> bool {
    configured(automation.precheck.as_ref()).is_none() || automation_store::get(&automation.id).is_ok_and(|current| current.enabled)
}

/// Run now. An automation with a first check returns its pending run at
/// once and goes on on a thread of its own; one whose check is already
/// running (from the scheduler or an earlier Run now) is refused. Without a
/// check, Run now is what it always was.
pub fn run_now(app: &impl AutomationHost, automation_id: &str) -> Result<AutomationRun> {
    let automation = automation_store::get(automation_id)?;
    if configured(automation.precheck.as_ref()).is_none() {
        return super::dispatch(app, automation_id, AutomationTrigger::Manual, None);
    }
    let claim = Claim::take(automation_id).context("This automation is already being checked or started. Try again in a moment.")?;
    let run = automation_store::insert_run(super::new_run(automation_id, AutomationTrigger::Manual, None, AutomationRunStatus::Pending))?;
    let worktree_name = (automation.workspace == AutomationWorkspace::NewWorktree)
        .then(|| super::automation_worktree_name(&automation, chrono::Utc::now()));
    let (worker, pending) = (app.clone(), run.clone());
    let spawned = std::thread::Builder::new().name("automation-run-now".into()).spawn(move || {
        let _claim = claim;
        let prompt = automation.prompt.clone();
        finishing(&worker, &automation.id, || super::start_run(&worker, &automation, pending, prompt, None, worktree_name).map(|_| ()));
    });
    if let Err(error) = spawned {
        let run = automation_store::replace_run(automation_id, &run.run_id, |value| {
            value.status = AutomationRunStatus::Failed;
            value.ended_at = Some(index::now());
            value.error = Some(format!("The run could not start: {error}"));
            Ok(())
        })?;
        emit_run(app, &run);
        return Ok(run);
    }
    Ok(run)
}

fn emit_removed(app: &impl AutomationHost, automation_id: &str, run_id: &str) {
    app.sink().emit("automation_run_removed", &serde_json::json!({ "automationId": automation_id, "runId": run_id }));
}

/// Record a check that ended its run (`status` is SkippedPrecheck or Failed).
/// When the newest other record is the same result (same trigger, same
/// status, same reason, from a check, with no session or issue), it is folded
/// into that record's repeat count and `pending`, if any, is removed.
fn record_ending(app: &impl AutomationHost, automation: &Automation, pending: Option<&AutomationRun>, trigger: AutomationTrigger, status: AutomationRunStatus, error: Option<String>, result: AutomationPrecheckResult) -> Result<AutomationRun> {
    let id = &automation.id;
    let pending_id = pending.map(|run| run.run_id.clone());
    let previous = automation_store::list_runs(id)?
        .into_iter()
        .find(|run| Some(&run.run_id) != pending_id.as_ref())
        .filter(|run| run.trigger == trigger && run.status == status && run.error == error && run.precheck.is_some() && run.issue.is_none() && run.session_id.is_none());
    let now = index::now();
    let run = if let Some(previous) = previous {
        let folded = automation_store::replace_run(id, &previous.run_id, |value| {
            value.repeat_count += 1;
            value.last_repeat_at = Some(now.clone());
            value.precheck = Some(result.clone());
            Ok(())
        })?;
        if let Some(pending_id) = pending_id {
            automation_store::remove_run(id, &pending_id)?;
            emit_removed(app, id, &pending_id);
        }
        folded
    } else if let Some(pending) = pending {
        automation_store::replace_run(id, &pending.run_id, |value| {
            value.status = status;
            value.ended_at = Some(now.clone());
            value.error = error.clone();
            value.precheck = Some(result.clone());
            Ok(())
        })?
    } else {
        let mut run = super::new_run(id, trigger, None, status);
        run.error = error;
        run.precheck = Some(result);
        automation_store::insert_run(run)?
    };
    emit_run(app, &run);
    update_summary(app, id, status, &now);
    Ok(run)
}

/// Why a run must not act on its check's result: the automation was deleted
/// or turned off while the check ran (a Run now still goes ahead when off),
/// or something else already ended the run.
enum Stale {
    Deleted,
    TurnedOff,
    Ended(Box<AutomationRun>),
}

fn stale(automation: &Automation, run: &AutomationRun) -> Option<Stale> {
    let Ok(current) = automation_store::get(&automation.id) else {
        return Some(Stale::Deleted);
    };
    let stored = automation_store::list_runs(&automation.id).ok()?.into_iter().find(|value| value.run_id == run.run_id);
    match stored {
        None => Some(Stale::Deleted),
        Some(stored) if stored.status != AutomationRunStatus::Pending => Some(Stale::Ended(Box::new(stored))),
        Some(_) if !current.enabled && run.trigger != AutomationTrigger::Manual => Some(Stale::TurnedOff),
        Some(_) => None,
    }
}

/// Run the automation's check, if it has one, for `run` (already pending).
/// Returns the prompt to send, with the check's output added, or `None` when
/// the run has ended here: "nothing new", failed, or no longer wanted.
/// Either way no session is created and no model is called.
pub(super) fn gate(app: &impl AutomationHost, automation: &Automation, run: &mut AutomationRun, prompt: String) -> Result<Option<String>> {
    let Some(precheck) = configured(automation.precheck.as_ref()) else {
        return Ok(Some(prompt));
    };
    if !agent_available(automation) {
        return Ok(Some(prompt));
    }
    let polled = POLL.with(|poll| match &*poll.borrow() {
        Some(memo) if memo.automation_id == automation.id => Some(memo.trial.clone()),
        _ => None,
    });
    // A poll's issue run was let through by the poll, which stops its batch
    // when the automation is turned off (`batch_goes_on`).
    let from_poll = polled.is_some();
    let trial = polled.unwrap_or_else(|| check(automation, precheck));
    match stale(automation, run) {
        None => {}
        Some(Stale::TurnedOff) if from_poll => {}
        Some(Stale::Deleted) => return Ok(None),
        Some(Stale::Ended(stored)) => {
            *run = *stored;
            return Ok(None);
        }
        Some(Stale::TurnedOff) => {
            *run = automation_store::replace_run(&automation.id, &run.run_id, |value| {
                value.status = AutomationRunStatus::Cancelled;
                value.ended_at = Some(index::now());
                value.error = Some("The automation was turned off while its first check ran.".into());
                value.precheck = Some(trial.result.clone());
                Ok(())
            })?;
            emit_run(app, run);
            let ended_at = run.ended_at.clone().unwrap_or_else(index::now);
            update_summary(app, &automation.id, run.status, &ended_at);
            return Ok(None);
        }
    }
    match trial.outcome {
        PrecheckOutcome::Proceed => {
            *run = automation_store::replace_run(&automation.id, &run.run_id, |value| {
                value.precheck = Some(trial.result.clone());
                Ok(())
            })?;
            emit_run(app, run);
            Ok(Some(prompt_with_output(&prompt, &precheck.command, &trial.result.stdout_tail, trial.result.truncated)))
        }
        PrecheckOutcome::NothingNew => {
            *run = record_ending(app, automation, Some(run), run.trigger, AutomationRunStatus::SkippedPrecheck, None, trial.result)?;
            Ok(None)
        }
        PrecheckOutcome::Failed => {
            *run = record_ending(app, automation, Some(run), run.trigger, AutomationRunStatus::Failed, trial.reason, trial.result)?;
            Ok(None)
        }
    }
}

/// An issue automation's check gates its poll. With no issues to start, the
/// check does not run. Nothing new or a failure starts no issue run, marks no
/// issue as seen and reports nothing on any issue: one history record (with
/// no issue) says what happened. Output lets every candidate go ahead with
/// it. `None` when the automation was changed, turned off or deleted while
/// the check ran: the poll then leaves everything as it is.
pub(super) fn gate_poll(app: &impl AutomationHost, automation: &Automation, candidates: Vec<crate::issues::Issue>) -> Result<Option<Vec<crate::issues::Issue>>> {
    let Some(precheck) = configured(automation.precheck.as_ref()) else {
        return Ok(Some(candidates));
    };
    if candidates.is_empty() || !agent_available(automation) {
        return Ok(Some(candidates));
    }
    let trial = check(automation, precheck);
    let Ok(current) = automation_store::get(&automation.id) else {
        return Ok(None);
    };
    if !current.enabled || current.issue_trigger != automation.issue_trigger || current.precheck != automation.precheck {
        return Ok(None);
    }
    match trial.outcome {
        PrecheckOutcome::Proceed => {
            POLL.with(|poll| *poll.borrow_mut() = Some(PollMemo { automation_id: automation.id.clone(), trial }));
            Ok(Some(candidates))
        }
        PrecheckOutcome::NothingNew => {
            record_ending(app, automation, None, AutomationTrigger::Issue, AutomationRunStatus::SkippedPrecheck, None, trial.result)?;
            Ok(Some(Vec::new()))
        }
        PrecheckOutcome::Failed => {
            record_ending(app, automation, None, AutomationTrigger::Issue, AutomationRunStatus::Failed, trial.reason, trial.result)?;
            Ok(Some(Vec::new()))
        }
    }
}

#[cfg(test)]
#[path = "precheck_tests.rs"]
mod tests;
