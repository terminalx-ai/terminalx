//! A send is never held up by slow work, and every send is timed (#727).
//!
//! Real panes and a stand-in for Claude Code, as in `session_unsent_tests`.
//! Slow work is held at its slow step (a merged sweep asking GitHub, Storage
//! sizing a worktree) while prompts are sent to tabs in the project and in
//! that very worktree: each must be answered while the work is still held.
//! Behind one app-wide lock, as before #727, none was answered until the
//! work was let go.
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

use super::*;

const IN_PROJECT: &str = "in-project";
const IN_WORKTREE: &str = "in-worktree";
const TAB: &str = "agent";
/// Up, saying so, and then reading what is typed at it.
const LISTENS: &str = "printf 'listening\\n'\nstty -icanon\nexec cat\n";
/// Ample for a send that waits on nothing; one held behind the work never comes within it.
const WAIT: Duration = Duration::from_secs(20);

struct Rig {
    manager: SessionManager,
    project: PathBuf,
    worktree: PathBuf,
    _dir: tempfile::TempDir,
    _claude: claude::pty::TestProgram,
    _home: store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        *crate::local_runtime::workspaces::PULL_REQUESTS.lock().unwrap_or_else(|error| error.into_inner()) = None;
        *crate::worktree_cleanup::WALKING.lock().unwrap_or_else(|error| error.into_inner()) = None;
        self.manager.closing();
        self.manager.terminals.kill_all();
    }
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn session(id: &str, project: &Path, cwd: &Path, worktree: Option<&str>) -> Value {
    json!({
        "id": id, "projectPath": project, "cwd": cwd, "title": id, "worktreeName": worktree,
        "created": index::now(), "modified": index::now(),
        "tabs": [{ "id": TAB, "harness": "claude", "permissionMode": "default", "created": index::now() }],
    })
}

impl Rig {
    /// A project with merged cleanup on and one TerminalX worktree, and a
    /// Claude tab in each.
    fn new() -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude");
        std::fs::write(&program, format!("#!/bin/sh\n{LISTENS}")).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let claude = claude::pty::claude_program_for_tests(program);
        let manager = SessionManager::new(
            Arc::new(crate::sink::BroadcastSink::new(1024)),
            Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()),
            Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        manager.follow_pane_exits();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let remote = base.join("app.git");
        std::fs::create_dir(&remote).unwrap();
        git(&remote, &["init", "-q", "--bare", "-b", "main"]);
        let project = base.join("app");
        std::fs::create_dir(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        git(&project, &["config", "user.email", "t@example.com"]);
        git(&project, &["config", "user.name", "T"]);
        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-q", "-m", "a"]);
        git(&project, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&project, &["push", "-q", "-u", "origin", "main"]);
        store::projects::add(project.to_str().unwrap()).unwrap();
        let worktree = std::fs::canonicalize(git::create_worktree(&project, "feature", Some("main")).unwrap().path).unwrap();
        let mut settings = store::settings::load();
        settings.merged_cleanup.enabled = true;
        store::settings::save(&settings).unwrap();
        let entries: Vec<index::SessionEntry> = [session(IN_PROJECT, &project, &project, None), session(IN_WORKTREE, &project, &worktree, Some("feature"))]
            .into_iter().map(|entry| serde_json::from_value(entry).unwrap()).collect();
        index::save(&entries).unwrap();
        Self { manager, project, worktree, _dir: dir, _claude: claude, _home: home }
    }

    /// A prompt to a session's tab, as the composer sends it. `None`: it was
    /// not answered within `WAIT`.
    fn send_within(&self, session: &str, text: &str, pressed_at: Option<i64>) -> Option<Result<SendOutcome>> {
        let (manager, session, text) = (self.manager.clone(), session.to_string(), text.to_string());
        let (answered, answer) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = answered.send(manager.send_pressed(&session, TAB, text, Vec::new(), pressed_at));
        });
        answer.recv_timeout(WAIT).ok()
    }

    /// Both tabs are sent a prompt now, and both answer.
    fn both_answer(&self, while_: &str) {
        for session in [IN_PROJECT, IN_WORKTREE] {
            let sent = self.send_within(session, &format!("hello while {while_}"), None)
                .unwrap_or_else(|| panic!("a prompt to {session} waited on {while_}"));
            let sent = sent.unwrap_or_else(|error| panic!("a prompt to {session} was refused while {while_}: {error:#}"));
            assert!(matches!(&sent.events[..], [event] if matches!(&event.payload, Payload::UserMessage { text, .. } if text.ends_with(while_))));
        }
    }

    fn rt(&self, session: &str) -> Arc<Mutex<TabRuntime>> {
        self.manager.runtime(session, TAB).unwrap()
    }

    fn wait(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "never happened: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// Work held at one step until the test lets it go.
struct Hold {
    reached: mpsc::Receiver<()>,
    release: mpsc::Sender<()>,
}

/// A hold, and what the held step runs: it says it got there, then waits.
fn hold() -> (Hold, impl Fn() + Send + 'static) {
    let (reached_tx, reached) = mpsc::channel();
    let (release, release_rx) = mpsc::channel::<()>();
    let at = move || {
        let _ = reached_tx.send(());
        let _ = release_rx.recv_timeout(WAIT * 3);
    };
    (Hold { reached, release }, at)
}

#[test]
fn a_prompt_is_answered_while_a_merged_sweep_waits_on_github() {
    let rig = Rig::new();
    let (held, at) = hold();
    *crate::local_runtime::workspaces::PULL_REQUESTS.lock().unwrap() = Some(Box::new(move |_, branches| {
        assert_eq!(branches, [git::worktree_branch("feature")]);
        at();
        Ok(HashMap::new())
    }));
    let manager = rig.manager.clone();
    let sweep = std::thread::spawn(move || manager.workspace("mergedSweep", json!({})));
    held.reached.recv_timeout(WAIT).expect("the sweep asks GitHub about the worktree's branch");
    rig.both_answer("a merged sweep asks GitHub");
    held.release.send(()).unwrap();
    sweep.join().unwrap().unwrap();
}

#[test]
fn a_prompt_is_answered_while_storage_sizes_a_worktree() {
    let rig = Rig::new();
    let (held, at) = hold();
    *crate::worktree_cleanup::WALKING.lock().unwrap() = Some(Box::new(at));
    let (manager, project, worktree) = (rig.manager.clone(), rig.project.clone(), rig.worktree.clone());
    let size = std::thread::spawn(move || manager.workspace("size", json!({ "job": "sizing", "projectPath": project, "path": worktree })));
    held.reached.recv_timeout(WAIT).expect("Storage walks the worktree");
    rig.both_answer("Storage sizes a worktree");
    held.release.send(()).unwrap();
    let size = size.join().unwrap().unwrap();
    assert!(size.as_u64().is_some_and(|bytes| bytes > 0), "{size}");
}

/// Admission still does what it is for: a checkout reserved for conflict
/// resolution takes no prompt but its resolver's, while every other
/// checkout's prompts go as usual.
#[test]
fn a_checkout_reserved_for_conflict_resolution_still_refuses_a_prompt() {
    use crate::issue_pipeline::{Pipeline, Resolution, SessionRef, Stage};
    let rig = Rig::new();
    let mut pipeline: Pipeline = serde_json::from_str(include_str!("fixtures/issue_pipeline.json")).unwrap();
    pipeline.author = SessionRef { session_id: IN_WORKTREE.into(), tab_id: TAB.into() };
    pipeline.resolver = Some(SessionRef { session_id: IN_WORKTREE.into(), tab_id: "resolver".into() });
    pipeline.resolution = Some(Resolution { head: "head".into(), remote_head: None, base: "main".into(), base_commit: "base".into(), return_stage: Stage::Work });
    crate::issue_pipeline::store::insert(&pipeline).unwrap();
    assert!(rig.send_within(IN_WORKTREE, "edit the conflicted file", None).expect("answered").is_err());
    // The composer's send says why in the tab, as it does for any refusal.
    let events = rig.manager.load_events(IN_WORKTREE, TAB).unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload, Payload::Error { detail: Some(detail), .. } if detail.contains("reserved for conflict resolution"))), "{events:?}");
    assert!(events.iter().all(|event| !matches!(event.payload, Payload::UserMessage { .. })), "the prompt never reached the chat");
    assert!(rig.manager.terminals.panes().is_empty(), "nor was an agent started for it");
    rig.send_within(IN_PROJECT, "elsewhere", None).expect("answered").expect("another checkout takes prompts");
}

/// What the tab's diagnostics say of one send, by stage.
fn timings(path: &Path, seq: u64) -> HashMap<String, Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|line| line["type"] == "send_timing" && line["seq"] == seq)
        .map(|line| (line["stage"].as_str().unwrap().to_string(), line))
        .collect()
}

/// Pressed, received, delivered and shown: every send's diagnostics hold
/// all four, so a slow one can be traced to the step that took the time.
#[test]
fn the_diagnostics_hold_all_four_timings_of_a_send() {
    let rig = Rig::new();
    let pressed = chrono::Utc::now().timestamp_millis() - 40;
    let sent = rig.send_within(IN_PROJECT, "time this", Some(pressed)).expect("answered").unwrap();
    let seq = sent.events[0].seq;
    let rt = rig.rt(IN_PROJECT);
    let path = rt.lock().unwrap().diagnostics_path();
    let received = timings(&path, seq).remove("received").expect("the runtime noted receiving it");
    let stamp = |value: &Value| chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap()).unwrap().timestamp_millis();
    assert_eq!(stamp(&received["pressed_at"]), pressed);
    assert!(stamp(&received["received_at"]) >= pressed);
    assert!(received["waited_ms"].as_i64().unwrap() >= 40);
    assert!(received["admitted_ms"].is_u64() && received["answered_ms"].is_u64());
    assert_eq!(received["queued"], false);

    // Claude Code takes it: it is up, and runs its prompt hook.
    if let Engine::Cli(cli) = &rt.lock().unwrap().engine { cli.ready.mark(); }
    rig.wait("the prompt to be typed", || String::from_utf8_lossy(&rig.manager.terminals.read_output(&SessionManager::pane_id(TAB)).unwrap_or_default()).contains("time this"));
    let token = match &rt.lock().unwrap().engine { Engine::Cli(cli) => cli.origin.token.clone(), _ => panic!("the CLI runs") };
    rig.manager.on_hook(HookFrame { session: IN_PROJECT.into(), tab: TAB.into(), token, event: "UserPromptSubmit".into(), payload: json!({}) });
    let delivered = timings(&path, seq).remove("delivered").expect("the runtime noted its delivery");
    assert!(delivered["ts"].is_string() && delivered["since_sent_ms"].is_u64());

    // The window drew it, and says when.
    let shown_at = chrono::Utc::now().timestamp_millis();
    rig.manager.note_shown(IN_PROJECT, TAB, seq, &SendShown { pressed_at: Some(pressed), drawn_at: Some(pressed + 8), answered_at: Some(shown_at - 2), shown_at }).unwrap();
    let shown = timings(&path, seq).remove("shown").expect("the window's timings were noted");
    assert_eq!(stamp(&shown["pressed_at"]), pressed);
    assert_eq!(stamp(&shown["drawn_at"]), pressed + 8);
    assert_eq!(stamp(&shown["shown_at"]), shown_at);
    assert_eq!(shown["shown_ms"].as_i64(), Some(shown_at - pressed));
}
