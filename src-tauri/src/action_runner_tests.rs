use super::*;
use std::sync::Arc;
use serde_json::json;
use crate::store::index::SessionEntry;
use crate::store::projects::{self, ProjectPatch};

pub(crate) struct Rig {
    pub manager: SessionManager,
    pub root: std::path::PathBuf,
    _dir: tempfile::TempDir,
    _home: store::TempHome,
}

impl Rig {
    pub fn new() -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&root).status().unwrap().success());
        projects::add(root.to_str().unwrap()).unwrap();
        let manager = SessionManager::new(
            Arc::new(crate::sink::BroadcastSink::new(128)), Arc::new(crate::sink::NoObserver),
            Arc::new(crate::harness::host::Host::new()), Arc::new(crate::pty::Terminals::new()),
            Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap(),
        );
        // As the desktop does: exit codes come from the panes' pty_exit events.
        observe(manager.sink().clone());
        Self { manager, root, _dir: dir, _home: home }
    }

    pub fn actions(&self, actions: Vec<RepositoryActionEntry>) {
        projects::update(self.root.to_str().unwrap(), ProjectPatch { actions: Some(actions), ..Default::default() }).unwrap();
    }

    pub fn entry(&self, id: &str) -> SessionEntry {
        let cwd = self.root.join(format!("work tree '{id}' $literal"));
        std::fs::create_dir(&cwd).unwrap();
        let entry: SessionEntry = serde_json::from_value(json!({
            "id": id, "projectPath": self.root, "cwd": cwd, "title": id,
            "worktreeName": id, "branch": "main", "created": "", "modified": "", "tabs": [],
        })).unwrap();
        store::index::update(|entries| { entries.push(entry.clone()); Ok(()) }).unwrap();
        entry
    }

    pub fn states(&self, session: &str) -> Vec<ActionRun> { states(&self.manager, session).unwrap() }

    /// Wait until `pane`'s run of `session` is in `state` (and, once exited, its code is heard).
    pub fn wait_for(&self, session: &str, pane: &str, state: State) -> ActionRun {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let listed = self.states(session);
            if let Some(run) = listed.iter().find(|r| r.pane_id == pane && r.state == state && (state == State::Running || r.ended.is_some())) { return run.clone() }
            assert!(Instant::now() < deadline, "expected {pane} {state:?}, got {listed:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn output(&self, pane: &str) -> String {
        String::from_utf8_lossy(&self.manager.terminals().read_output(pane).unwrap_or_default()).into_owned()
    }

    fn action_panes(&self) -> Vec<String> {
        let mut panes: Vec<_> = self.manager.terminals().panes().into_iter().map(|p| p.id).filter(|id| parse_pane(id).is_some()).collect();
        panes.sort();
        panes
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.closing();
        self.manager.terminals().kill_all();
    }
}

pub(crate) fn action(id: &str, command: &str) -> RepositoryActionEntry {
    RepositoryActionEntry { id: id.into(), name: format!("Action {id}"), command: command.into(), ..Default::default() }
}

fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn pane_ids_name_their_session_and_any_action_id() {
    for id in ["dev", "a-b:c d", "ünï'code\"$x", &"x".repeat(MAX_ACTION_ID)] {
        let pane = pane_id("session-1", id).unwrap();
        assert!(pane.len() <= 256);
        assert_eq!(crate::pty::shell_session(&pane), Some("session-1"), "a shell tab of the session");
        assert_eq!(parse_pane(&pane), Some(("session-1", id.to_string())));
    }
    assert!(pane_id("s", &"x".repeat(MAX_ACTION_ID + 1)).is_err());
    assert!(pane_id("s", "").is_err());
    // Ordinary shell tabs and setup panes are not action runs.
    for other in ["s:0190aaaa-bbbb", "s:workspace-setup-1", "tab:abc", "s:action-", "s:action-run-zz", "s:action-run-6"] {
        assert_eq!(parse_pane(other), None, "{other}");
    }
}

#[test]
fn an_action_runs_in_a_terminal_tab_with_the_workspace_environment_and_reports_its_real_exit_code() {
    let rig = Rig::new();
    let entry = rig.entry("env");
    // Hidden only keeps an action out of menus; asked for by id it still runs.
    // Quotes and `&&` prove the command runs whole, as the reader's shell reads it.
    rig.actions(vec![RepositoryActionEntry { hidden: true, ..action("dev",
        "printf 'cwd=%s\\nport=%s\\nports=%s\\nworkspace=%s\\naction=%s\\n' \"$PWD\" \"$TERMINALX_PORT\" \"$TERMINALX_PORTS\" \"$TERMINALX_WORKSPACE_PATH\" \"$TERMINALX_ACTION_ID\" && sleep 0.3 && exit 7") }]);
    let heard = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    for name in [EVENT, "pty_opened", "pty_exit"] {
        let heard = heard.clone();
        rig.manager.sink().listen(name, Box::new(move |raw| heard.lock().unwrap().push((name.to_string(), raw.to_string()))));
    }
    let outcome = run(&rig.manager, &entry.id, "dev", RunOptions::default()).unwrap();
    assert!(outcome.started);
    assert_eq!(outcome.run.state, State::Running);
    assert_eq!(outcome.run.exit_code, None);
    assert_eq!(outcome.run.action_id, "dev");
    let pane = outcome.run.pane_id.clone();
    // A shell tab of this session, named after the action, in the workspace.
    let shell = rig.manager.terminals().shell(&pane).expect("the action is a terminal tab of its session");
    assert_eq!(shell.session_id, entry.id);
    assert_eq!(shell.title.as_deref(), Some("Action dev"));
    assert_eq!(shell.cwd, entry.cwd);
    assert_eq!(outcome.run.name, "Action dev");

    let exited = rig.wait_for(&entry.id, &pane, State::Exited);
    assert_eq!(exited.exit_code, Some(7), "the PTY child's own exit code");
    // The code is the one in the tab's own pty_exit event.
    let heard_now = heard.lock().unwrap().clone();
    let exit: PtyExit = heard_now.iter().filter(|(name, _)| name == "pty_exit").map(|(_, raw)| serde_json::from_str::<PtyExit>(raw).unwrap())
        .find(|exit| exit.id == pane).expect("the tab's exit is announced");
    assert_eq!(exit.code, Some(7));

    let ports: HashMap<String, String> = store::index::workspace_ports::environment(&entry.cwd).unwrap().into_iter().collect();
    assert!(!ports["TERMINALX_PORT"].is_empty());
    let text = rig.output(&pane);
    let cwd = std::fs::canonicalize(&entry.cwd).unwrap();
    assert!(text.contains(&format!("cwd={}\r\n", cwd.display())), "{text}");
    assert!(text.contains(&format!("port={}\r\n", ports["TERMINALX_PORT"])), "{text}");
    assert!(text.contains(&format!("ports={}\r\n", ports["TERMINALX_PORTS"])), "{text}");
    assert!(text.contains(&format!("workspace={}\r\n", entry.cwd)), "{text}");
    assert!(text.contains("action=dev\r\n"), "{text}");

    // The tab opened in every window, and its exit was told as an action change.
    wait_until("the action change event", || heard.lock().unwrap().iter().any(|(name, raw)| name == EVENT && raw.contains(&pane)));
    let heard_now = heard.lock().unwrap().clone();
    assert!(heard_now.iter().any(|(name, raw)| name == "pty_opened" && raw.contains(&pane)));
    let change: serde_json::Value = serde_json::from_str(&heard_now.iter().find(|(name, _)| name == EVENT).unwrap().1).unwrap();
    assert_eq!(change, json!({"sessionId": entry.id, "paneId": pane}));

    // A program that succeeds reports 0; the exited tab stays listed beside it until closed.
    rig.actions(vec![action("dev", "true")]);
    let second = run(&rig.manager, &entry.id, "dev", RunOptions::default()).unwrap();
    assert!(second.started, "an exited run does not hold back a new one");
    assert_eq!(rig.wait_for(&entry.id, &second.run.pane_id, State::Exited).exit_code, Some(0));
    assert_eq!(rig.states(&entry.id).iter().map(|r| r.pane_id.clone()).collect::<Vec<_>>(), vec![pane.clone(), second.run.pane_id.clone()]);
    rig.manager.terminals().kill(&pane);
    assert_eq!(rig.states(&entry.id).len(), 1, "a closed tab is no longer a run");
    assert!(rig.states("another-session").is_empty());
    assert!(run(&rig.manager, &entry.id, "missing", RunOptions::default()).is_err());
}

#[test]
fn a_running_non_concurrent_action_is_returned_and_restart_replaces_it() {
    let rig = Rig::new();
    let entry = rig.entry("single");
    let count = Path::new(&entry.cwd).join("count");
    let watched = Path::new(&entry.cwd).join("watched");
    rig.actions(vec![
        // Slow to stop, as a server letting go of its port: the restart waits for it.
        action("server", "printf x >> count; trap 'sleep 0.3; printf - >> count; exit 0' TERM HUP; sleep 60 & wait"),
        RepositoryActionEntry { concurrent: true, ..action("watch", "printf w >> watched; exec sleep 60") },
    ]);
    let first = run(&rig.manager, &entry.id, "server", RunOptions::default()).unwrap();
    assert!(first.started);
    wait_until("the first run to start", || std::fs::read_to_string(&count).is_ok_and(|c| c == "x"));

    let again = run(&rig.manager, &entry.id, "server", RunOptions::default()).unwrap();
    assert!(!again.started, "nothing new starts");
    assert_eq!(again.run, first.run, "the running tab comes back for the UI to focus");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(std::fs::read_to_string(&count).unwrap(), "x");
    assert_eq!(rig.action_panes(), vec![first.run.pane_id.clone()]);

    let restarted = run(&rig.manager, &entry.id, "server", RunOptions { restart: true }).unwrap();
    assert!(restarted.started);
    assert_ne!(restarted.run.pane_id, first.run.pane_id);
    assert!(!rig.manager.terminals().is_live(&first.run.pane_id), "the old tab is closed");
    wait_until("the restarted run to start", || std::fs::read_to_string(&count).is_ok_and(|c| c.len() == 3));
    assert_eq!(std::fs::read_to_string(&count).unwrap(), "x-x", "the new run started once the old one had exited");
    assert_eq!(rig.action_panes(), vec![restarted.run.pane_id.clone()]);
    let listed = rig.states(&entry.id);
    assert_eq!(listed.iter().map(|r| (r.pane_id.clone(), r.state)).collect::<Vec<_>>(), vec![(restarted.run.pane_id.clone(), State::Running)]);

    // "Allow several at once" starts a new tab every time.
    let a = run(&rig.manager, &entry.id, "watch", RunOptions::default()).unwrap();
    let b = run(&rig.manager, &entry.id, "watch", RunOptions::default()).unwrap();
    assert!(a.started && b.started);
    assert_ne!(a.run.pane_id, b.run.pane_id);
    wait_until("both concurrent runs", || std::fs::read_to_string(&watched).is_ok_and(|c| c == "ww"));

    // A run ended from outside reports the process's own end: a signal, not success.
    rig.manager.terminals().stop_keep_output(&a.run.pane_id, Duration::from_secs(5));
    let ended = rig.wait_for(&entry.id, &a.run.pane_id, State::Exited);
    assert_ne!(ended.exit_code, Some(0));
    assert_eq!(rig.states(&entry.id).iter().filter(|r| r.state == State::Running).count(), 2);
}

/// The desktop hears runtime events as the bridge hands them on: `emit_raw`
/// on the app's handle. A run the runtime started (Run after setup) gets its
/// code there too.
#[cfg(feature = "desktop")]
#[test]
fn the_desktop_records_an_exit_relayed_from_the_runtime() {
    let app = tauri::test::mock_app();
    let sink: Arc<dyn EventSink> = Arc::new(app.handle().clone());
    let listener = observe(sink.clone());
    let pane = pane_id("relayed", "dev").unwrap();
    sink.emit_raw("pty_exit", serde_json::value::to_raw_value(&PtyExit { id: pane.clone(), code: Some(4) }).unwrap());
    // Not an action tab: not recorded.
    sink.emit_raw("pty_exit", serde_json::value::to_raw_value(&PtyExit { id: "relayed:plain".into(), code: Some(1) }).unwrap());
    wait_until("the relayed exit", || exits().lock().contains_key(&pane));
    assert_eq!(exits().lock()[&pane].code, Some(4));
    assert!(!exits().lock().contains_key("relayed:plain"));
    sink.unlisten(listener);
}
