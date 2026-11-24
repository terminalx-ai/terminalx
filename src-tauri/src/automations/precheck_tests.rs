use super::*;
#[cfg(unix)]
use std::collections::BTreeMap;
use crate::automations::{evaluate, AutomationTrigger};
use crate::sink::EventSink;

fn run(command: &str, seconds: u64) -> PrecheckTrial {
    let dir = tempfile::tempdir().unwrap();
    execute(command, Duration::from_secs(seconds), dir.path(), &[], &[])
}

/// Whether `pid` is gone, waiting a moment for the kill to land.
fn gone(pid: &str) -> bool {
    #[cfg(unix)]
    let pid: libc::pid_t = pid.trim().parse().unwrap();
    #[cfg(windows)]
    let pid: u32 = pid.trim().parse().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        // SAFETY: signal 0 only asks whether the process exists.
        #[cfg(unix)]
        let ended = unsafe { libc::kill(pid, 0) } == -1;
        #[cfg(windows)]
        let ended = !crate::win::process::is_running(pid);
        if ended {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

// What one execution says.

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

/// Prints the id of the background process just started, as this system names it.
const BACKGROUND_ID: &str = if cfg!(windows) { "cat /proc/$!/winpid" } else { "echo $!" };

#[test]
fn a_background_process_ends_with_the_check() {
    let started = Instant::now();
    let trial = run(&format!("sleep 30 & {BACKGROUND_ID}"), 10);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(trial.outcome, PrecheckOutcome::Proceed);
    assert!(gone(&trial.result.stdout_tail));
}

#[test]
fn a_background_process_ends_with_a_timed_out_check() {
    let trial = run(&format!("sleep 30 & {BACKGROUND_ID}; sleep 30"), 1);
    assert!(trial.result.timed_out);
    assert!(gone(&trial.result.stdout_tail));
}

#[test]
fn a_process_that_outlives_the_one_that_started_it_ends_with_the_check() {
    // A subshell starts the process at once and exits: nothing the check
    // itself started is its parent any more, whether the check ends or hangs.
    for _ in 0..5 {
        let trial = run(&format!("(sleep 30 & {BACKGROUND_ID})"), 10);
        assert_eq!(trial.outcome, PrecheckOutcome::Proceed);
        assert!(gone(&trial.result.stdout_tail), "{}", trial.result.stdout_tail);
    }
    let trial = run(&format!("(sleep 30 & {BACKGROUND_ID}); sleep 30"), 1);
    assert!(trial.result.timed_out);
    assert!(gone(&trial.result.stdout_tail), "{}", trial.result.stdout_tail);
}

/// The check's shell is in its job, with what it started, while it runs.
#[cfg(windows)]
#[test]
fn a_running_check_and_what_it_started_are_in_one_job() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().to_path_buf();
    let check = std::thread::spawn(move || execute("cat /proc/$$/winpid > pid; sleep 30 & sleep 30", Duration::from_secs(6), &folder, &[], &[]));
    let sleeping = |pid: u32| crate::win::process::image_path(pid).is_ok_and(|image| image.file_name().is_some_and(|name| name.eq_ignore_ascii_case("sleep.exe")));
    let deadline = Instant::now() + Duration::from_secs(5);
    // Both the background process and the one the shell waits on.
    let (shell, started) = loop {
        let shell = std::fs::read_to_string(dir.path().join("pid")).ok().and_then(|text| text.trim().parse::<u32>().ok());
        if let Some(shell) = shell {
            // Git for Windows' `bin\sh.exe` is a launcher, so the job is
            // recorded under its id and the shell is a member of it.
            let members = crate::win::process::members_of_job_holding(shell).expect("the check's shell is in a job tied to this process");
            let started: Vec<u32> = members.into_iter().filter(|pid| sleeping(*pid)).collect();
            if started.len() >= 2 {
                break (shell, started);
            }
        }
        assert!(Instant::now() < deadline, "the check's job never held what it started");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(check.join().unwrap().result.timed_out);
    assert!(gone(&shell.to_string()));
    assert!(started.iter().all(|pid| gone(&pid.to_string())), "{started:?}");
    assert!(crate::win::process::members_of_job_holding(shell).is_none());
}

#[test]
fn output_is_capped_and_marked_truncated() {
    let trial = run("head -c 100000 /dev/zero | tr '\\0' x", 10);
    assert_eq!(trial.outcome, PrecheckOutcome::Proceed);
    assert_eq!(trial.result.stdout_tail.len(), STDOUT_CAP);
    assert!(trial.result.truncated);
}

#[test]
fn a_flood_on_standard_error_is_capped_and_does_not_block() {
    let started = Instant::now();
    let trial = run("head -c 2000000 /dev/zero | tr '\\0' e >&2; echo done", 10);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(trial.outcome, PrecheckOutcome::Proceed);
    assert_eq!(trial.result.stdout_tail, "done\n");
    assert_eq!(trial.result.stderr_tail.len(), STDERR_CAP);
    assert!(trial.result.truncated);
}

#[test]
fn a_cut_never_splits_a_character() {
    let trial = run(&format!("head -c {} /dev/zero | tr '\\0' x; printf 'ééé'", STDOUT_CAP - 1), 10);
    assert!(trial.result.truncated);
    assert!(!trial.result.stdout_tail.contains('\u{FFFD}'));
    assert_eq!(trial.result.stdout_tail.len(), STDOUT_CAP - 1);
    assert_eq!(complete_utf8_end("aé".as_bytes()), 3);
    assert_eq!(complete_utf8_end(&"a€".as_bytes()[..3]), 1);
    assert_eq!(complete_utf8_end(&"a😀".as_bytes()[..4]), 1);
}

#[test]
fn leading_whitespace_does_not_use_up_the_cap() {
    let trial = run("head -c 40000 /dev/zero | tr '\\0' ' '; echo; echo real", 10);
    assert_eq!(trial.outcome, PrecheckOutcome::Proceed);
    assert_eq!(trial.result.stdout_tail, "real\n");
    assert!(!trial.result.truncated);
}

#[test]
fn a_command_in_a_missing_folder_cannot_start_and_fails() {
    let trial = execute("true", Duration::from_secs(5), Path::new("/nonexistent/precheck-folder"), &[], &[]);
    assert_eq!(trial.outcome, PrecheckOutcome::Failed);
    assert!(trial.reason.unwrap().contains("could not start"));
}

// `pwd -P` and a login PATH are written the POSIX way.
#[cfg(unix)]
#[test]
fn the_check_gets_a_panes_environment_in_its_folder() {
    let project = tempfile::tempdir().unwrap();
    crate::store::environment::set_test_launch(BTreeMap::from([
        ("PRECHECK_PROBE".to_string(), "from-overrides".to_string()),
        ("PATH".to_string(), "/nowhere".to_string()),
        ("CLAUDECODE".to_string(), "1".to_string()),
    ]));
    // Git for Windows' sh shows its PATH in its own form (/c/...), and `pwd -W` is its Windows path.
    let command = if cfg!(windows) { "pwd -W; printf '%s|%s' \"$PRECHECK_PROBE\" \"${CLAUDECODE-unset}\"" } else { "pwd -P; printf '%s|%s|%s' \"$PRECHECK_PROBE\" \"$PATH\" \"${CLAUDECODE-unset}\"" };
    let precheck = AutomationPrecheck { command: command.into(), timeout_seconds: 10 };
    let trial = run_in(&project.path().to_string_lossy(), AutomationWorkspace::NewWorktree, None, &precheck).unwrap();
    let folder = crate::paths::canonicalize(project.path()).unwrap();
    if cfg!(windows) {
        let printed = trial.result.stdout_tail.replace('/', "\\");
        let (shown, rest) = printed.split_once('\n').unwrap();
        assert!(shown.eq_ignore_ascii_case(&folder.to_string_lossy()), "{shown}");
        assert_eq!(rest, "from-overrides|unset");
    } else {
        assert_eq!(trial.result.stdout_tail, format!("{}\nfrom-overrides|{}|unset", folder.display(), crate::binpath::login_path()));
    }
}

// The run paths: Run now, the scheduler (due and missed) and issue polls.

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
    Host(Arc::new(crate::sink::BroadcastSink::new(512)))
}

fn events(receiver: &mut tokio::sync::broadcast::Receiver<crate::sink::Published>, name: &str) -> Vec<serde_json::Value> {
    let mut found = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        if &*event.event == name {
            found.push(serde_json::from_str(&event.payload).unwrap());
        }
    }
    found
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

fn issue_automation(project: &Path, command: &str) -> Automation {
    let mut automation = saved(project, Some(command), 30, "2099-01-01T00:00:00Z");
    automation.issue_trigger = Some(serde_json::from_value(serde_json::json!({
        "provider": "github", "repo": "acme/widgets", "query": "label:raccoon",
    })).unwrap());
    automation_store::save(std::slice::from_ref(&automation)).unwrap();
    automation
}

fn issues() -> Vec<crate::issues::Issue> {
    let value: serde_json::Value = serde_json::from_str(include_str!("../fixtures/github_issue_list.json")).unwrap();
    crate::issues::parse_github_issues(&value)
}

fn runs(automation: &Automation) -> Vec<AutomationRun> {
    automation_store::list_runs(&automation.id).unwrap()
}

fn only_run(automation: &Automation) -> AutomationRun {
    let mut runs = runs(automation);
    assert_eq!(runs.len(), 1, "{runs:?}");
    runs.remove(0)
}

fn pending(automation: &Automation, trigger: AutomationTrigger) -> AutomationRun {
    automation_store::insert_run(super::super::new_run(&automation.id, trigger, None, AutomationRunStatus::Pending)).unwrap()
}

/// Wait for checks running on threads of their own.
fn settle() {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !CHECKING.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "an automation's check did not finish");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn no_sessions() -> bool {
    index::load().unwrap().is_empty()
}

fn lines(path: &Path) -> usize {
    std::fs::read_to_string(path).map(|text| text.lines().count()).unwrap_or(0)
}

#[test]
fn run_now_returns_at_once_and_a_quiet_check_logs_nothing_new_without_a_session() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("sleep 1"), 30, "2099-01-01T00:00:00Z");
    let started = Instant::now();
    let run = run_now(&host(), &automation.id).unwrap();
    assert!(started.elapsed() < Duration::from_millis(900));
    assert_eq!(run.status, AutomationRunStatus::Pending);
    settle();
    let run = only_run(&automation);
    assert_eq!(run.status, AutomationRunStatus::SkippedPrecheck);
    assert_eq!(run.trigger, AutomationTrigger::Manual);
    assert!(run.session_id.is_none() && run.error.is_none() && run.ended_at.is_some());
    assert_eq!(run.precheck.as_ref().unwrap().exit_code, Some(0));
    assert_eq!(automation_store::get(&automation.id).unwrap().last_outcome, Some(AutomationRunStatus::SkippedPrecheck));
    assert!(no_sessions());
}

#[test]
fn run_now_with_a_failing_check_is_a_failed_run_without_a_session() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("echo 'gh: not logged in' >&2; exit 4"), 30, "2099-01-01T00:00:00Z");
    run_now(&host(), &automation.id).unwrap();
    settle();
    let run = only_run(&automation);
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
    run_now(&host(), &automation.id).unwrap();
    settle();
    let run = only_run(&automation);
    assert_eq!(run.status, AutomationRunStatus::Failed);
    assert!(run.precheck.as_ref().unwrap().timed_out);
    assert!(run.error.unwrap().contains("did not finish"));
    assert!(no_sessions());
}

#[test]
fn run_now_is_refused_while_the_check_is_already_running() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("sleep 1"), 30, "2099-01-01T00:00:00Z");
    run_now(&host(), &automation.id).unwrap();
    let error = run_now(&host(), &automation.id).unwrap_err().to_string();
    assert!(error.contains("already being checked or started"), "{error}");
    settle();
    assert_eq!(runs(&automation).len(), 1);
}

#[test]
fn repeated_results_fold_into_one_record_and_the_pending_run_is_removed() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let host = host();
    let mut events_seen = host.0.subscribe();
    let automation = saved(project.path(), Some("true"), 30, "2099-01-01T00:00:00Z");
    for _ in 0..3 {
        run_now(&host, &automation.id).unwrap();
        settle();
    }
    let run = only_run(&automation);
    assert_eq!((run.status, run.repeat_count), (AutomationRunStatus::SkippedPrecheck, 3));
    assert!(run.last_repeat_at.is_some());
    assert_eq!(events(&mut events_seen, "automation_run_removed").len(), 2);

    // A failure is a record of its own; the same failure again folds into it.
    automation_store::update(&automation.id, |value| {
        value.precheck = Some(AutomationPrecheck { command: "exit 2".into(), timeout_seconds: 30 });
        Ok(())
    })
    .unwrap();
    for _ in 0..2 {
        run_now(&host, &automation.id).unwrap();
        settle();
    }
    let all = runs(&automation);
    assert_eq!(all.len(), 2);
    assert_eq!((all[0].status, all[0].repeat_count), (AutomationRunStatus::Failed, 2));
    assert_eq!(all[1].repeat_count, 3);
}

#[test]
fn output_goes_ahead_with_the_output_in_the_prompt() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("echo 'PR #7 needs review'"), 30, "2099-01-01T00:00:00Z");
    let mut run = pending(&automation, AutomationTrigger::Manual);
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
        let mut run = pending(&automation, AutomationTrigger::Manual);
        let before = run.clone();
        assert_eq!(gate(&host(), &automation, &mut run, "Prompt".into()).unwrap().as_deref(), Some("Prompt"));
        assert_eq!(run, before);
        assert!(only_run(&automation).precheck.is_none());
        automation_store::remove(&automation.id).unwrap();
    }
}

struct AgentMissing;

impl AgentMissing {
    fn set() -> Self {
        AGENT_MISSING.store(true, std::sync::atomic::Ordering::SeqCst);
        Self
    }
}

impl Drop for AgentMissing {
    fn drop(&mut self) {
        AGENT_MISSING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[test]
fn a_missing_agent_is_reported_without_running_the_check() {
    let _home = crate::store::temp_home();
    let _missing = AgentMissing::set();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("touch ran"), 30, "2099-01-01T00:00:00Z");
    let mut run = pending(&automation, AutomationTrigger::Scheduled);
    assert_eq!(gate(&host(), &automation, &mut run, "Prompt".into()).unwrap().as_deref(), Some("Prompt"));
    assert!(gate_poll(&host(), &automation, issues()).unwrap().is_some_and(|candidates| !candidates.is_empty()));
    assert!(!project.path().join("ran").exists());
}

#[test]
fn an_automation_turned_off_during_its_check_does_not_fire() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("echo work"), 30, "2099-01-01T00:00:00Z");
    automation_store::update(&automation.id, |value| {
        value.enabled = false;
        Ok(())
    })
    .unwrap();
    let mut scheduled = pending(&automation, AutomationTrigger::Scheduled);
    assert!(gate(&host(), &automation, &mut scheduled, "Prompt".into()).unwrap().is_none());
    assert_eq!(scheduled.status, AutomationRunStatus::Cancelled);
    assert!(scheduled.error.unwrap().contains("turned off"));
    // Run now on an automation that is off still goes ahead.
    let mut manual = pending(&automation, AutomationTrigger::Manual);
    assert!(gate(&host(), &automation, &mut manual, "Prompt".into()).unwrap().is_some());
    // A deleted one leaves nothing behind.
    let mut gone = pending(&automation, AutomationTrigger::Manual);
    automation_store::remove(&automation.id).unwrap();
    assert!(gate(&host(), &automation, &mut gone, "Prompt".into()).unwrap().is_none());
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
    let missed = (chrono::Utc::now() - chrono::TimeDelta::days(2)).to_rfc3339();
    let automation = saved(project.path(), Some("touch ran"), 30, &missed);
    evaluate(&host()).unwrap();
    settle();
    let run = only_run(&automation);
    assert_eq!(run.status, AutomationRunStatus::SkippedMissed);
    assert!(run.precheck.is_none());
    assert!(!project.path().join("ran").exists());
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
    // Due again while its check is still going: no second run, and Run now
    // waits its turn too.
    automation_store::update(&automation.id, |value| {
        value.next_run_at = due.clone();
        Ok(())
    })
    .unwrap();
    evaluate(&host()).unwrap();
    assert!(run_now(&host(), &automation.id).is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
    settle();
    assert_eq!(only_run(&automation).status, AutomationRunStatus::SkippedPrecheck);
}

// An issue automation's check gates its poll.

#[test]
fn a_poll_with_no_issues_to_start_does_not_run_the_check() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = issue_automation(project.path(), "touch ran");
    assert_eq!(gate_poll(&host(), &automation, Vec::new()).unwrap().map(|value| value.len()), Some(0));
    assert!(!project.path().join("ran").exists());
    assert!(runs(&automation).is_empty());
}

#[test]
fn a_quiet_poll_starts_and_stamps_no_issue_and_folds_into_one_record() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = issue_automation(project.path(), "true");
    for _ in 0..2 {
        assert_eq!(gate_poll(&host(), &automation, issues()).unwrap().map(|value| value.len()), Some(0));
    }
    let run = only_run(&automation);
    assert_eq!((run.status, run.trigger, run.repeat_count), (AutomationRunStatus::SkippedPrecheck, AutomationTrigger::Issue, 2));
    assert!(run.issue.is_none());
    assert!(automation_store::load_seen(&automation.id).unwrap().is_none());
}

#[test]
fn a_failing_poll_check_is_one_failed_record_with_no_issue_to_report_on() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = issue_automation(project.path(), "exit 1");
    assert_eq!(gate_poll(&host(), &automation, issues()).unwrap().map(|value| value.len()), Some(0));
    let run = only_run(&automation);
    assert_eq!(run.status, AutomationRunStatus::Failed);
    // evaluate_issue reports a failure on an issue only for a run with one.
    assert!(run.issue.is_none());
    assert!(automation_store::load_seen(&automation.id).unwrap().is_none());
}

#[test]
fn a_poll_with_output_lets_every_issue_go_ahead_on_one_check() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = issue_automation(project.path(), "echo ran >> checks; echo 'two issues'");
    let candidates = issues();
    let count = candidates.len();
    assert!(count >= 2);
    assert_eq!(gate_poll(&host(), &automation, candidates).unwrap().map(|value| value.len()), Some(count));
    for _ in 0..2 {
        let mut run = pending(&automation, AutomationTrigger::Issue);
        let prompt = gate(&host(), &automation, &mut run, "Fix it.".into()).unwrap().unwrap();
        assert!(prompt.contains("two issues"));
    }
    POLL.with(|poll| *poll.borrow_mut() = None);
    assert_eq!(lines(&project.path().join("checks")), 1);
}

#[test]
fn a_poll_whose_automation_changed_during_the_check_leaves_everything_alone() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let mut automation = issue_automation(project.path(), "true");
    automation.issue_trigger.as_mut().unwrap().query = "label:older".into();
    assert!(gate_poll(&host(), &automation, issues()).unwrap().is_none());
    assert!(runs(&automation).is_empty());
}

#[test]
fn an_issue_batch_stops_when_the_automation_is_turned_off_and_its_started_runs_go_on() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = issue_automation(project.path(), "echo work");
    assert!(batch_goes_on(&automation));
    assert!(gate_poll(&host(), &automation, issues()).unwrap().is_some_and(|candidates| !candidates.is_empty()));
    automation_store::update(&automation.id, |value| {
        value.enabled = false;
        Ok(())
    })
    .unwrap();
    // The poll's loop stops before the next issue's run and seen stamp.
    assert!(!batch_goes_on(&automation));
    // A run the poll already let through is not cancelled by its gate.
    let mut started = pending(&automation, AutomationTrigger::Issue);
    assert!(gate(&host(), &automation, &mut started, "Fix it.".into()).unwrap().is_some());
    assert_eq!(started.status, AutomationRunStatus::Pending);
    POLL.with(|poll| *poll.borrow_mut() = None);
    // Without a check, a batch goes on as it always has.
    let plain = saved(project.path(), None, 30, "2099-01-01T00:00:00Z");
    assert!(batch_goes_on(&plain));
}

#[test]
fn a_run_left_pending_after_its_check_is_ended_as_failed() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("echo work"), 30, "2099-01-01T00:00:00Z");
    let older = pending(&automation, AutomationTrigger::Manual);
    automation_store::replace_run(&automation.id, &older.run_id, |value| {
        value.started_at = Some("2026-01-01T00:00:00.000Z".into());
        Ok(())
    })
    .unwrap();
    let host = host();
    finishing(&host, &automation.id, || {
        pending(&automation, AutomationTrigger::Manual);
        anyhow::bail!("store write failed")
    });
    finishing(&host, &automation.id, || {
        pending(&automation, AutomationTrigger::Manual);
        panic!("after the check")
    });
    let all = runs(&automation);
    assert_eq!(all.iter().filter(|run| run.status == AutomationRunStatus::Failed).count(), 2);
    // A run from before this work is not its to end.
    assert_eq!(all.iter().find(|run| run.run_id == older.run_id).unwrap().status, AutomationRunStatus::Pending);
}

#[test]
fn nothing_is_started_for_an_automation_with_nothing_due() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("touch ran"), 30, "2099-01-01T00:00:00Z");
    assert!(evaluate_apart(&host(), &automation, chrono::Utc::now()));
    assert!(CHECKING.lock().unwrap().is_empty());
    // Run now is not refused for a check that is not running.
    run_now(&host(), &automation.id).unwrap();
    settle();
    assert!(project.path().join("ran").exists());
}

#[test]
fn try_it_refuses_a_session_from_another_project() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let created = index::now();
    let entry: index::SessionEntry = serde_json::from_value(serde_json::json!({
        "id": "other-session", "projectPath": elsewhere.path().to_string_lossy(), "cwd": elsewhere.path().to_string_lossy(),
        "title": "Other", "created": created, "modified": created, "tabs": [],
    }))
    .unwrap();
    index::update(|sessions| {
        sessions.push(entry);
        Ok(())
    })
    .unwrap();
    let error = try_precheck(PrecheckTryInput {
        project_path: project.path().to_string_lossy().into_owned(),
        workspace: AutomationWorkspace::Session,
        session_id: Some("other-session".into()),
        precheck: AutomationPrecheck { command: "true".into(), timeout_seconds: 5 },
    })
    .unwrap_err()
    .to_string();
    assert!(error.contains("another project"), "{error}");
}

// Saving.

#[test]
fn saving_trims_the_command_and_applies_the_timeout_rules() {
    assert_eq!(normalized(None), None);
    assert_eq!(normalized(Some(AutomationPrecheck { command: "  ".into(), timeout_seconds: 5 })), None);
    assert_eq!(
        normalized(Some(AutomationPrecheck { command: " gh pr list \n".into(), timeout_seconds: 0 })),
        Some(AutomationPrecheck { command: "gh pr list".into(), timeout_seconds: DEFAULT_TIMEOUT_SECONDS }),
    );
    let without_timeout: AutomationPrecheck = serde_json::from_str(r#"{"command":"true"}"#).unwrap();
    assert_eq!(without_timeout.timeout_seconds, DEFAULT_TIMEOUT_SECONDS);
}

#[test]
fn issue_runs_per_tick_are_capped_when_saved() {
    let input = |runs: u32| -> super::super::AutomationInput {
        serde_json::from_value(serde_json::json!({
            "name": "Issues", "projectPath": "/repo", "harness": "codex", "prompt": "Fix {{title}}", "workspace": "newWorktree",
            "schedule": { "kind": "preset", "preset": "hourly", "timezone": "UTC", "dtstart": "2026-01-01T00:00:00Z" },
            "issueTrigger": { "provider": "github", "repo": "acme/widgets", "query": "label:raccoon", "maxRunsPerTick": runs },
        }))
        .unwrap()
    };
    let now = chrono::Utc::now();
    let saved = |runs| super::super::definition_from_input(input(runs), None, now).unwrap().issue_trigger.unwrap().max_runs_per_tick;
    assert_eq!(saved(50), 50);
    // An older automation with more still saves and toggles, clamped.
    assert_eq!(saved(80), 50);
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

/// PRO-490 review: a run ended by something else while the orphans are failed
/// is not ended or reported again.
#[test]
fn an_orphan_ended_meanwhile_is_not_ended_again() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("echo x"), 30, "2099-01-01T00:00:00Z");
    let since = chrono::Utc::now() - chrono::TimeDelta::seconds(1);
    let mut orphan = pending(&automation, AutomationTrigger::Manual);
    orphan = automation_store::replace_run(&automation.id, &orphan.run_id, |run| {
        run.started_at = Some(index::now());
        Ok(())
    })
    .unwrap();
    let id = automation.id.clone();
    BEFORE_ORPHAN.with(|hook| *hook.borrow_mut() = Some(Box::new(move |run_id: &str| {
        automation_store::replace_run(&id, run_id, |run| {
            run.status = AutomationRunStatus::Completed;
            run.ended_at = Some(index::now());
            Ok(())
        })
        .unwrap();
    })));
    let app = host();
    let mut events_seen = app.0.subscribe();
    fail_orphans(&app, &automation.id, since);
    BEFORE_ORPHAN.with(|hook| *hook.borrow_mut() = None);
    let run = only_run(&automation);
    assert_eq!((run.run_id, run.status), (orphan.run_id, AutomationRunStatus::Completed));
    assert!(events(&mut events_seen, "automation_run").is_empty(), "nothing was ended or reported again");
    assert!(automation_store::get(&automation.id).unwrap().last_outcome.is_none());
}

/// PRO-490 review: a Run now whose thread cannot start fails, and is ended as
/// any failed run: in the automation's summary (and a duty's report).
#[test]
fn a_run_now_that_cannot_start_its_thread_ends_as_failed() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let automation = saved(project.path(), Some("echo x"), 30, "2099-01-01T00:00:00Z");
    NO_THREAD.with(|no| no.set(true));
    let run = run_now(&host(), &automation.id);
    NO_THREAD.with(|no| no.set(false));
    let run = run.unwrap();
    assert_eq!(run.status, AutomationRunStatus::Failed);
    assert!(run.error.as_deref().unwrap_or_default().starts_with("The run could not start"), "{run:?}");
    assert_eq!(automation_store::get(&automation.id).unwrap().last_outcome, Some(AutomationRunStatus::Failed));
}
