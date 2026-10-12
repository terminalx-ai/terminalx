//! A cloud workspace's scheduled runs (PRO-37, terminalx-saas contract
//! §24.4) against the real runtime: `terminalx-serve` claims a run from the
//! fake API, starts the fake Claude Code in the schedule's mode with its
//! prompt, reports the start and the end, never sends a prompt twice, and
//! ends a turn that outlasts the schedule's limit.

#![cfg(unix)]

mod common;

use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use common::agent::{count, texts, wait_until, AgentWorld, Serve};
use common::mailbox::{FakeMailbox, ScheduledRun};
use serde_json::{json, Value};

fn python() -> bool {
    let found = std::process::Command::new("python3").arg("--version").output().is_ok();
    if !found {
        eprintln!("skipped: python3 is not installed");
    }
    found
}

fn run(id: &str, prompt: &str, max_run_minutes: u32) -> Value {
    json!({
        "runId": id, "scheduleId": "csc_test", "name": "Nightly checks", "scheduledFor": 1_792_713_600_000u64,
        "agent": "claude", "mode": "manual", "prompt": prompt, "maxRunMinutes": max_run_minutes,
    })
}

struct World {
    world: AgentWorld,
    mailbox: FakeMailbox,
    _link_dir: tempfile::TempDir,
    link: std::path::PathBuf,
}

impl World {
    fn new() -> Self {
        let world = AgentWorld::new();
        let mailbox = FakeMailbox::start(7);
        // No relay to reach: a run needs only the API.
        let link_dir = tempfile::tempdir().unwrap();
        let link = link_dir.path().join("link.json");
        std::fs::write(
            &link,
            json!({
                "v": 1, "hostSecretB64": STANDARD.encode([7u8; 32]), "relayToken": "unused", "directorUrl": "http://127.0.0.1:1",
                "attachments": [], "mailbox": mailbox.link_section(),
            })
            .to_string(),
        )
        .unwrap();
        Self { world, mailbox, _link_dir: link_dir, link }
    }

    fn start(&self) -> Serve {
        let mut command = self.world.command();
        command.args(["--runtime-kind", "cloud-workspace", "--relay-link"]).arg(&self.link);
        Serve::start(command, &self.world.data)
    }

    /// The run once it left `working`, within `deadline`.
    fn settled(&self, run_id: &str, deadline: Duration) -> ScheduledRun {
        let until = Instant::now() + deadline;
        loop {
            let run = self.mailbox.scheduled_run(run_id);
            if run.state != "provisioning" && run.state != "working" {
                return run;
            }
            assert!(Instant::now() < until, "timed out waiting for {run_id} to end: {:?}", run.reports);
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Whether an agent process of this world is running: the fake CLI is
    /// started as this world's own `bin/claude`.
    fn agent_running(&self) -> bool {
        let listed = std::process::Command::new("ps").args(["-Ao", "command"]).output().unwrap();
        let ours = self.world.bin.join("claude").display().to_string();
        String::from_utf8_lossy(&listed.stdout).lines().any(|line| line.contains(&ours))
    }

    /// The tab the runtime said it started for the run.
    fn tab(&self, run_id: &str) -> String {
        wait_until("the start of the run to be reported", || {
            self.mailbox.scheduled_run(run_id).reports.iter().find(|report| report["outcome"] == "started").and_then(|report| report["tabId"].as_str().map(String::from))
        })
    }
}

#[test]
fn a_run_is_claimed_once_runs_its_prompt_and_is_reported() {
    if !python() {
        return;
    }
    let world = World::new();
    world.mailbox.add_scheduled_run(run("csr_one", "echo:the nightly checks pass", 5));
    let serve = world.start();
    let done = world.settled("csr_one", Duration::from_secs(60));
    assert_eq!((done.state.as_str(), done.category.as_deref()), ("completed", None), "{:?}", done.reports);
    let outcomes: Vec<_> = done.reports.iter().map(|report| report["outcome"].as_str().unwrap_or_default()).collect();
    assert_eq!(outcomes, ["started", "completed"]);
    let tab = world.tab("csr_one");
    let events = serve.events(&tab);
    assert_eq!(texts(&events, "user_message"), vec!["echo:the nightly checks pass"]);
    assert_eq!(texts(&events, "assistant_text"), vec!["the nightly checks pass"]);
    // The session carries the schedule's name.
    assert!(serve.control("sessions.list", json!({})).to_string().contains("Nightly checks"));
    // The run is over, and so is its agent process: nothing idles on a
    // workspace people keep up. The transcript stays.
    wait_until("the agent process to end", || (!world.agent_running()).then_some(()));

    // A restart asks again and gets nothing: no second tab, prompt or report.
    drop(serve);
    let claims = world.mailbox.scheduled_claims();
    let serve = world.start();
    wait_until("the restarted runtime to claim", || (world.mailbox.scheduled_claims() > claims).then_some(()));
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(world.mailbox.scheduled_run("csr_one").reports.len(), 2);
    assert_eq!(texts(&serve.events(&tab), "user_message"), vec!["echo:the nightly checks pass"]);
    assert_eq!(serve.control("sessions.list", json!({}))["sessions"].as_array().map(Vec::len), Some(1));
}

#[test]
fn a_run_asks_before_it_acts_in_the_schedules_mode() {
    if !python() {
        return;
    }
    let world = World::new();
    // `manual`: the fake CLI runs a command unasked in bypass permissions,
    // which is how a tab started with no mode is launched
    // (`--dangerously-skip-permissions`). A runner that dropped the mode
    // would run the command and this test would see no request.
    world.mailbox.add_scheduled_run(run("csr_ask", "ask:touch scheduled.txt", 5));
    let serve = world.start();
    let pending = wait_until("the permission request", || {
        serve.control("permissions.list", json!({}))["permissions"].as_array().filter(|pending| !pending.is_empty()).cloned()
    });
    assert_eq!(pending[0]["toolName"], "Bash");
    // The tab is in the schedule's mode, as the session index records it.
    let session = serve.control("sessions.list", json!({}))["sessions"][0].clone();
    assert_eq!(session["tabs"][0]["permissionMode"], "manual", "{session}");
    assert_eq!(world.mailbox.scheduled_run("csr_ask").state, "working");
    assert!(!world.world.project.join("scheduled.txt").exists());
    serve.control("permissions.deny", json!({ "request": pending[0]["requestId"] }));
    let done = world.settled("csr_ask", Duration::from_secs(60));
    assert_eq!(done.state, "completed", "{:?}", done.reports);
    assert!(texts(&serve.events(&world.tab("csr_ask")), "assistant_text").iter().any(|text| text == "denied: touch scheduled.txt"));
}

#[test]
fn a_runtime_killed_in_the_middle_of_a_run_fails_it_and_never_sends_the_prompt_again() {
    if !python() {
        return;
    }
    let world = World::new();
    world.mailbox.add_scheduled_run(run("csr_cut", "slow:200:500", 5));
    let mut serve = world.start();
    let tab = world.tab("csr_cut");
    serve.wait_events(&tab, "the turn to start", |events| texts(events, "assistant_text").iter().any(|text| text == "chunk 1 of 200"));
    // Killed, not stopped: nothing gets to tidy up.
    serve.kill();
    // Already reaped: its `Drop` would signal a process id that is no longer its own.
    std::mem::forget(serve);

    let serve = world.start();
    let done = world.settled("csr_cut", Duration::from_secs(60));
    assert_eq!((done.state.as_str(), done.category.as_deref()), ("failed", Some("runtime-error")), "{:?}", done.reports);
    assert_eq!(done.reports.last().unwrap()["tabId"], tab.as_str());
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(texts(&serve.events(&tab), "user_message"), vec!["slow:200:500"], "the prompt is in the transcript once");
    assert_eq!(serve.control("sessions.list", json!({}))["sessions"].as_array().map(Vec::len), Some(1));
}

#[test]
fn a_turn_that_outlasts_the_limit_is_ended_and_reported_timed_out() {
    if !python() {
        return;
    }
    let world = World::new();
    // 400 messages half a second apart: more than three minutes of turn
    // against a limit of one.
    world.mailbox.add_scheduled_run(run("csr_long", "slow:400:500", 1));
    let serve = world.start();
    let began = Instant::now();
    let tab = world.tab("csr_long");
    serve.wait_events(&tab, "the turn to start", |events| count(events, "assistant_text") >= 1);
    assert!(world.agent_running(), "the check below would otherwise prove nothing");
    let done = world.settled("csr_long", Duration::from_secs(120));
    assert_eq!((done.state.as_str(), done.category.as_deref()), ("failed", Some("timed-out")), "{:?}", done.reports);
    assert!(began.elapsed() >= Duration::from_secs(55), "not before the limit: {:?}", began.elapsed());
    // The turn is over: closed in the transcript, and the agent says no more.
    let events = serve.wait_events(&tab, "the turn to close", |events| count(events, "turn_completed") >= 1);
    let said = count(&events, "assistant_text");
    assert!(said < 400, "{said}");
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(count(&serve.events(&tab), "assistant_text"), said);
    wait_until("the agent process to end", || (!world.agent_running()).then_some(()));
}

#[test]
fn a_run_that_stops_at_a_permission_request_with_nobody_attached_is_ended_and_says_why() {
    if !python() {
        return;
    }
    let world = World::new();
    // A limit of ten minutes. Nobody is attached (there is no relay), so
    // nobody can answer: the run is not left to bill the machine until then.
    world.mailbox.add_scheduled_run(run("csr_wait", "ask:touch scheduled.txt", 10));
    let serve = world.start();
    let began = Instant::now();
    wait_until("the permission request", || serve.control("permissions.list", json!({}))["permissions"].as_array().filter(|pending| !pending.is_empty()).cloned());
    let done = world.settled("csr_wait", Duration::from_secs(5 * 60));
    assert_eq!((done.state.as_str(), done.category.as_deref()), ("failed", Some("needs-approval")), "{:?}", done.reports);
    // Given the few minutes someone opening the workspace needs to connect.
    assert!(began.elapsed() >= Duration::from_secs(170), "{:?}", began.elapsed());
    assert!(!world.world.project.join("scheduled.txt").exists(), "nothing was run unasked");
    assert!(serve.control("permissions.list", json!({}))["permissions"].as_array().is_none_or(Vec::is_empty));
    wait_until("the agent process to end", || (!world.agent_running()).then_some(()));
}

#[test]
fn scheduled_runs_turned_off_under_a_running_turn_let_it_finish() {
    if !python() {
        return;
    }
    let world = World::new();
    // 150 messages half a second apart: the turn outlives the runner's
    // once-a-minute question to the server, which is answered `404`.
    world.mailbox.add_scheduled_run(run("csr_flag", "slow:150:500", 5));
    let serve = world.start();
    let tab = world.tab("csr_flag");
    world.mailbox.turn_scheduled_runs_off();
    let events = serve.wait_events_for(&tab, "the turn to end by itself", Duration::from_secs(150), |events| count(events, "turn_completed") >= 1);
    assert_eq!(count(&events, "assistant_text"), 150, "the turn was not cut short");
    // Nothing reached the server after the flag went off: the run is its to time out.
    let run = world.mailbox.scheduled_run("csr_flag");
    assert_eq!((run.state.as_str(), run.reports.len()), ("working", 1), "{:?}", run.reports);
}

#[test]
fn a_server_with_scheduled_runs_turned_off_is_left_alone() {
    let world = World::new();
    world.mailbox.turn_scheduled_runs_off();
    world.mailbox.add_scheduled_run(run("csr_off", "echo:never sent", 5));
    let serve = world.start();
    wait_until("the runtime to ask", || (world.mailbox.scheduled_claims() >= 1).then_some(()));
    // Nothing else is disturbed: the mailbox is still read. And the runtime
    // does not ask again for minutes.
    let leases = world.mailbox.lease_calls();
    wait_until("the mailbox to be read again", || (world.mailbox.lease_calls() > leases).then_some(()));
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(world.mailbox.scheduled_claims(), 1);
    let waiting = world.mailbox.scheduled_run("csr_off");
    assert_eq!((waiting.state.as_str(), waiting.reports.len()), ("provisioning", 0));
    assert_eq!(serve.control("sessions.list", json!({}))["sessions"].as_array().map(Vec::len).unwrap_or(0), 0);
}
