use super::*;
use std::time::Instant;
use crate::store::projects::{self, ProjectPatch, RepositoryScripts};

struct Rig {
    manager: SessionManager,
    root: std::path::PathBuf,
    ids: Vec<String>,
    _dir: tempfile::TempDir,
    _home: store::TempHome,
}
impl Rig {
    fn new() -> Self {
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
        Self { manager, root, ids: Vec::new(), _dir: dir, _home: home }
    }
    fn script(&self, command: &str) {
        projects::update(self.root.to_str().unwrap(), ProjectPatch { scripts: Some(RepositoryScripts { setup: command.into(), archive: String::new(), archive_timeout_minutes: None }), ..Default::default() }).unwrap();
    }
    fn entry(&mut self, id: &str) -> SessionEntry {
        let cwd = self.root.join(format!("work tree '{id}' $literal"));
        std::fs::create_dir(&cwd).unwrap();
        let entry: SessionEntry = serde_json::from_value(json!({
            "id": id, "projectPath": self.root, "cwd": cwd, "title": id,
            "worktreeName": id, "branch": "main", "created": "", "modified": "", "tabs": [],
        })).unwrap();
        store::index::update(|entries| { entries.push(entry.clone()); Ok(()) }).unwrap();
        self.ids.push(id.into());
        entry
    }
    fn wait(&self, session: &str, expected: Status) -> Setup {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let setup = read(session).unwrap().unwrap();
            if setup.status == expected { return setup }
            assert!(Instant::now() < deadline, "expected {expected:?}, got {setup:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.closing();
        for id in &self.ids {
            if let Some(control) = controls().lock().get(id) { control.cancel.store(true, Ordering::Release); }
        }
        self.manager.terminals().kill_all();
        let until = Instant::now() + Duration::from_secs(10);
        while self.ids.iter().any(|id| controls().lock().contains_key(id)) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn only_explicit_local_configuration_can_create_an_automatic_attempt() {
    let mut rig = Rig::new();
    let entry = rig.entry("source");
    let repo_config = rig.root.join("terminalx.json");
    let untrusted = r#"{"scripts":{"setup":"touch untrusted"}}"#;
    std::fs::write(&repo_config, untrusted).unwrap();
    prepare(&entry).unwrap();
    assert!(read(&entry.id).unwrap().is_none());
    assert!(start(&rig.manager, &entry.id, false).unwrap().is_none());
    assert!(start(&rig.manager, &entry.id, true).is_err());
    let defaults: RepositoryScripts = serde_json::from_value(json!({"archive": "cleanup"})).unwrap();
    assert!(defaults.setup.is_empty());
    assert!(serde_json::from_value::<RepositoryScripts>(json!({"setup": false})).is_err());

    rig.script("printf local > marker");
    prepare(&entry).unwrap();
    start(&rig.manager, &entry.id, false).unwrap();
    rig.wait(&entry.id, Status::Succeeded);
    assert_eq!(std::fs::read_to_string(Path::new(&entry.cwd).join("marker")).unwrap(), "local");
    assert!(!Path::new(&entry.cwd).join("untrusted").exists());
    // Saving local settings never modifies or creates a repository config file.
    assert_eq!(std::fs::read_to_string(&repo_config).unwrap(), untrusted);
    std::fs::write(&repo_config, r#"{"scripts":{"setup":"touch changed-by-pull"}}"#).unwrap();
    start(&rig.manager, &entry.id, true).unwrap();
    rig.wait(&entry.id, Status::Succeeded);
    assert!(!Path::new(&entry.cwd).join("changed-by-pull").exists());
}

#[test]
fn old_repository_file_snapshots_are_never_resumed() {
    let mut rig = Rig::new();
    let entry = rig.entry("old");
    let mut old = attempt(&entry, "touch untrusted".into());
    old.local_script = false;
    save(&old).unwrap();
    recover(&rig.manager);
    assert_eq!(read(&entry.id).unwrap().unwrap().status, Status::Failed);
    assert!(!Path::new(&entry.cwd).join("untrusted").exists());
    assert!(rig.manager.terminals().panes().is_empty());
}

#[test]
fn creation_events_start_a_prepared_attempt_without_blocking_admission() {
    let mut rig = Rig::new();
    let entry = rig.entry("created");
    rig.script("printf automatic > marker");
    prepare(&entry).unwrap();
    follow_creations(&rig.manager);
    {
        // Creation can emit while its caller still holds admission. Dispatch
        // must return immediately and let the worker acquire it afterwards.
        let _admission = crate::issue_pipeline::admission::lock();
        rig.manager.sink().emit(CREATED_EVENT, &entry);
    }
    rig.wait(&entry.id, Status::Succeeded);
    assert_eq!(std::fs::read_to_string(Path::new(&entry.cwd).join("marker")).unwrap(), "automatic");
}

#[test]
fn runs_once_with_exact_environment_and_retains_failure_output() {
    let mut rig = Rig::new();
    let entry = rig.entry("once");
    rig.script("printf '%s\\n' \"$TERMINALX_WORKSPACE_PATH\" \"$TERMINALX_REPO_ROOT\" \"$TERMINALX_BRANCH\" \"$TERMINALX_SESSION_ID\"\nprintf run >> count");
    let env = archive_script::environment(&rig.root, Path::new(&entry.cwd), Some(&entry));
    assert_eq!(env, vec![
        ("TERMINALX_WORKSPACE_PATH".into(), entry.cwd.clone()),
        ("TERMINALX_REPO_ROOT".into(), entry.project_path.clone()),
        ("TERMINALX_BRANCH".into(), "main".into()),
        ("TERMINALX_SESSION_ID".into(), entry.id.clone()),
    ]);
    prepare(&entry).unwrap();
    start(&rig.manager, &entry.id, false).unwrap();
    let first = rig.wait(&entry.id, Status::Succeeded);
    let output = log(&rig.manager, &entry.id, &first.pane_id).unwrap();
    for (_, value) in env { assert!(output.contains(&value), "{output}"); }
    start(&rig.manager, &entry.id, false).unwrap();
    assert_eq!(read(&entry.id).unwrap().unwrap().pane_id, first.pane_id);
    assert_eq!(std::fs::read_to_string(Path::new(&entry.cwd).join("count")).unwrap(), "run");
    rig.script("i=0; while [ \"$i\" -lt 4096 ]; do printf 'bounded output line\\n'; i=$((i+1)); done; printf 'failure log\\n'; exit 7");
    start(&rig.manager, &entry.id, true).unwrap();
    let failed = rig.wait(&entry.id, Status::Failed);
    assert_eq!(failed.exit_code, Some(7));
    assert!(failed.log.len() <= 32 * 1024);
    assert!(failed.log.ends_with("failure log\r\n"));
    assert!(log(&rig.manager, &entry.id, &first.pane_id).is_err());
    rig.manager.terminals().kill_all();
    assert!(log(&rig.manager, &entry.id, &failed.pane_id).unwrap().contains("failure log"));
}

#[test]
fn queue_limits_concurrency_and_stop_never_executes_a_queued_attempt() {
    let mut rig = Rig::new();
    rig.script("printf started > started; read answer");
    let entries: Vec<_> = (0..3).map(|n| rig.entry(&format!("queue-{n}"))).collect();
    for entry in &entries { prepare(entry).unwrap(); start(&rig.manager, &entry.id, false).unwrap(); }
    let first = rig.wait(&entries[0].id, Status::Running);
    let second = rig.wait(&entries[1].id, Status::Running);
    let queued = read(&entries[2].id).unwrap().unwrap();
    assert_eq!(queued.status, Status::Pending);
    assert!(!Path::new(&entries[2].cwd).join("started").exists());
    assert!(start(&rig.manager, &entries[0].id, true).is_err());
    stop(&rig.manager, &queued.session_id, &queued.pane_id).unwrap();
    rig.wait(&queued.session_id, Status::Stopped);
    stop(&rig.manager, &first.session_id, &first.pane_id).unwrap();
    rig.wait(&first.session_id, Status::Stopped);
    // Drain the cancelled job and exercise a new explicit attempt in that slot.
    rig.script("printf done > done");
    start(&rig.manager, &queued.session_id, true).unwrap();
    rig.wait(&queued.session_id, Status::Succeeded);
    assert!(!Path::new(&entries[2].cwd).join("started").exists());
    assert!(Path::new(&entries[2].cwd).join("done").exists());
    assert!(stop(&rig.manager, &queued.session_id, &queued.pane_id).is_err());
    stop(&rig.manager, &second.session_id, &second.pane_id).unwrap();
    rig.wait(&second.session_id, Status::Stopped);
}

#[test]
fn timeout_stops_descendants_and_exposes_a_retryable_failure() {
    let mut rig = Rig::new();
    let entry = rig.entry("timeout");
    rig.script("echo before-timeout; sleep 60 & wait");
    prepare(&entry).unwrap();
    schedule(&rig.manager, &entry.id, false, Duration::from_millis(200)).unwrap();
    let failed = rig.wait(&entry.id, Status::Failed);
    assert_eq!(failed.exit_code, Some(124));
    assert!(failed.error.as_deref().unwrap().contains("timed out"));
    assert!(failed.log.contains("before-timeout"));
    assert!(rig.manager.terminals().stop_keep_output(&failed.pane_id, Duration::from_millis(100)));
    rig.script("exit 0");
    start(&rig.manager, &entry.id, true).unwrap();
    rig.wait(&entry.id, Status::Succeeded);
}

#[test]
fn an_untrusted_committed_setup_script_becomes_a_failed_setup_and_never_runs() {
    let mut rig = Rig::new();
    let entry = rig.entry("refused");
    std::fs::create_dir(rig.root.join(".terminalx")).unwrap();
    std::fs::write(rig.root.join(".terminalx/settings.json"), r#"{"setupScript":"touch untrusted"}"#).unwrap();
    prepare(&entry).unwrap();
    assert_eq!(read(&entry.id).unwrap().unwrap().status, Status::Pending, "recorded, so the refusal is reported");
    start_pending(&rig.manager, &entry.id);
    let setup = rig.wait(&entry.id, Status::Failed);
    assert!(setup.error.as_deref().unwrap_or_default().contains("setup script that is not trusted"), "{setup:?}");
    assert!(setup.error.as_deref().unwrap_or_default().contains("Open Settings → Projects → Scripts"), "{setup:?}");
    assert!(!Path::new(&entry.cwd).join("untrusted").exists());
}

#[test]
fn an_untrusted_committed_archive_script_leaves_the_saved_setup_running() {
    let mut rig = Rig::new();
    let entry = rig.entry("independent");
    rig.script("printf saved > marker");
    std::fs::create_dir(rig.root.join(".terminalx")).unwrap();
    std::fs::write(rig.root.join(".terminalx/settings.json"), r#"{"archiveScript":"touch untrusted"}"#).unwrap();
    prepare(&entry).unwrap();
    start(&rig.manager, &entry.id, false).unwrap();
    rig.wait(&entry.id, Status::Succeeded);
    assert_eq!(std::fs::read_to_string(Path::new(&entry.cwd).join("marker")).unwrap(), "saved");
}

#[test]
fn run_after_setup_actions_start_only_once_setup_succeeds() {
    use crate::action_runner::{self, State};
    let mut rig = Rig::new();
    action_runner::observe(rig.manager.sink().clone());
    let entry = rig.entry("after");
    let cwd = Path::new(&entry.cwd).to_path_buf();
    let runs = |rig: &Rig| action_runner::states(&rig.manager, &entry.id).unwrap();
    // "Allow several at once", so a second start would open a second tab.
    let action = |id: &str, command: &str, run_after_setup: bool| projects::RepositoryActionEntry {
        id: id.into(), name: id.into(), command: command.into(), run_after_setup, concurrent: true, ..Default::default()
    };
    projects::update(rig.root.to_str().unwrap(), ProjectPatch { actions: Some(vec![
        // Proves it ran after setup's own work, in the same workspace.
        action("dev", "test -f setup-done && printf ran >> ran", true),
        action("manual", "printf manual > manual", false),
    ]), ..Default::default() }).unwrap();

    rig.script("exit 3");
    prepare(&entry).unwrap();
    start(&rig.manager, &entry.id, false).unwrap();
    assert_eq!(rig.wait(&entry.id, Status::Failed).exit_code, Some(3));
    std::thread::sleep(Duration::from_millis(500));
    assert!(runs(&rig).is_empty(), "a failed setup starts nothing");
    assert!(!cwd.join("ran").exists());

    rig.script("sleep 0.3; printf done > setup-done");
    start(&rig.manager, &entry.id, true).unwrap();
    // Nothing is started while setup is still running.
    rig.wait(&entry.id, Status::Running);
    assert!(runs(&rig).is_empty());
    rig.wait(&entry.id, Status::Succeeded);
    let deadline = Instant::now() + Duration::from_secs(30);
    let run = loop {
        if let Some(run) = runs(&rig).into_iter().find(|r| r.state == State::Exited && r.ended.is_some()) { break run }
        assert!(Instant::now() < deadline, "the run-after-setup action never finished: {:?}", runs(&rig));
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!((run.action_id.as_str(), run.exit_code), ("dev", Some(0)));
    assert_eq!(std::fs::read_to_string(cwd.join("ran")).unwrap(), "ran");
    assert_eq!(runs(&rig).len(), 1, "only the run-after-setup action runs");
    assert!(!cwd.join("manual").exists());

    // A manual Rerun setup that succeeds again starts nothing more.
    rig.script("printf again > setup-again");
    start(&rig.manager, &entry.id, true).unwrap();
    rig.wait(&entry.id, Status::Succeeded);
    assert!(cwd.join("setup-again").exists());
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(runs(&rig).len(), 1, "a rerun does not start Run after setup actions again");
    assert_eq!(std::fs::read_to_string(cwd.join("ran")).unwrap(), "ran");
}

#[test]
fn run_after_setup_actions_start_when_a_new_workspace_has_no_setup_script() {
    use crate::action_runner::State;
    let mut rig = Rig::new();
    crate::action_runner::observe(rig.manager.sink().clone());
    follow_creations(&rig.manager);
    projects::update(rig.root.to_str().unwrap(), ProjectPatch { actions: Some(vec![projects::RepositoryActionEntry {
        id: "dev".into(), name: "dev".into(), command: "printf ready > ready; exec sleep 60".into(), run_after_setup: true, ..Default::default()
    }]), ..Default::default() }).unwrap();
    let entry = rig.entry("plain");
    prepare(&entry).unwrap();
    assert!(read(&entry.id).unwrap().is_none(), "no setup script, so no setup attempt");
    rig.manager.sink().emit(CREATED_EVENT, &entry);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !Path::new(&entry.cwd).join("ready").exists() {
        assert!(Instant::now() < deadline, "the run-after-setup action never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    let runs = crate::action_runner::states(&rig.manager, &entry.id).unwrap();
    assert_eq!(runs.iter().map(|r| (r.action_id.as_str(), r.state)).collect::<Vec<_>>(), vec![("dev", State::Running)]);
}

#[test]
fn adopting_a_dirty_worktree_does_not_initialize_it_or_run_after_setup_actions() {
    let mut rig = Rig::new();
    crate::git::run(&rig.root, &["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]).unwrap();
    let workspace = crate::git::create_worktree(&rig.root, "existing", None).unwrap();
    let dirty = Path::new(&workspace.path).join("dirty.txt");
    std::fs::write(&dirty, "uncommitted work").unwrap();
    projects::update(rig.root.to_str().unwrap(), ProjectPatch { actions: Some(vec![projects::RepositoryActionEntry {
        id: "automatic".into(), name: "automatic".into(), command: "printf action > action-ran".into(), run_after_setup: true, ..Default::default()
    }]), ..Default::default() }).unwrap();
    crate::action_runner::observe(rig.manager.sink().clone());
    follow_creations(&rig.manager);
    let created = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let heard = created.clone();
    rig.manager.sink().listen(CREATED_EVENT, Box::new(move |payload| {
        heard.lock().unwrap().push(serde_json::from_str::<SessionEntry>(payload).unwrap().id);
    }));
    // Cover both creation entry points, with and without a configured script:
    // after-setup actions must not run in either adoption case.
    for script in ["printf overwritten > dirty.txt", ""] {
        rig.script(script);
        for named in [false, true] {
            let req = serde_json::from_value(json!({
                "projectPath": rig.root, "cwd": workspace.path, "useWorktree": true,
                "tab": { "harness": "claude", "model": "" },
            })).unwrap();
            let entry = if named {
                crate::session_ops::create_named_session_blocking(rig.manager.sink().as_ref(), req, None).unwrap()
            } else {
                crate::session_ops::create_session_blocking(rig.manager.sink().as_ref(), req).unwrap()
            };
            rig.ids.push(entry.id.clone());
            assert_eq!(entry.worktree_name.as_deref(), Some("existing"));
            assert!(read(&entry.id).unwrap().is_none(), "adoption must not prepare setup");
            assert!(created.lock().unwrap().is_empty(), "adoption must not dispatch workspace initialization");
            assert!(crate::action_runner::states(&rig.manager, &entry.id).unwrap().is_empty());
            assert_eq!(std::fs::read_to_string(&dirty).unwrap(), "uncommitted work");
            assert!(!Path::new(&workspace.path).join("action-ran").exists());
        }
    }
    // The same production path still prepares and dispatches setup for an
    // actually new worktree, followed by its automatic actions.
    rig.script("printf initialized > initialized");
    let req = serde_json::from_value(json!({
        "projectPath": rig.root, "useWorktree": true,
        "tab": { "harness": "claude", "model": "" },
    })).unwrap();
    let fresh = crate::session_ops::create_session_blocking(rig.manager.sink().as_ref(), req).unwrap();
    rig.ids.push(fresh.id.clone());
    assert_eq!(*created.lock().unwrap(), vec![fresh.id.clone()]);
    rig.wait(&fresh.id, Status::Succeeded);
    assert!(Path::new(&fresh.cwd).join("initialized").exists());
    let deadline = Instant::now() + Duration::from_secs(30);
    while !Path::new(&fresh.cwd).join("action-ran").exists() {
        assert!(Instant::now() < deadline, "new workspace's after-setup action never ran");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(std::fs::read_to_string(&dirty).unwrap(), "uncommitted work");
}
