use std::process::Command;
use std::sync::Mutex;

use super::*;

/// The server's side of §19.3, enough to drive the launcher: one intent,
/// claimed by incarnation, settled once.
struct FakeApi {
    intent: Mutex<Option<Claim>>,
    state: Mutex<String>,
    claimed_by: Mutex<Option<String>>,
    phases: Mutex<Vec<String>>,
    completions: Mutex<Vec<Outcome>>,
    fail_complete: Mutex<u32>,
    /// The user cancels just before this phase is reported.
    cancel_at: Mutex<Option<&'static str>>,
}

impl FakeApi {
    fn new(claim: Option<Claim>) -> Arc<Self> {
        Arc::new(Self {
            intent: Mutex::new(claim),
            state: Mutex::new("pending".into()),
            claimed_by: Mutex::new(None),
            phases: Mutex::new(Vec::new()),
            completions: Mutex::new(Vec::new()),
            fail_complete: Mutex::new(0),
            cancel_at: Mutex::new(None),
        })
    }
}

impl LaunchApi for FakeApi {
    fn claim(&self, incarnation: &str) -> Result<Option<Claim>, CallError> {
        let Some(mut claim) = self.intent.lock().unwrap().clone() else { return Ok(None) };
        let mut state = self.state.lock().unwrap();
        let mut claimed_by = self.claimed_by.lock().unwrap();
        match state.as_str() {
            "pending" => {
                *state = "claimed".into();
                *claimed_by = Some(incarnation.into());
                claim.state = "deliver".into();
            }
            "claimed" if claimed_by.as_deref() == Some(incarnation) => {
                claim.state = "deliver".into();
                claim.redelivery = true;
            }
            "claimed" => {
                *state = "outcome-unknown".into();
                claim.state = "outcome-unknown".into();
                claim.prompt = None;
            }
            settled => {
                claim.state = settled.into();
                claim.prompt = None;
            }
        }
        Ok(Some(claim))
    }

    fn phase(&self, _launch_id: &str, phase: &str) -> Result<Option<String>, CallError> {
        self.phases.lock().unwrap().push(phase.into());
        let mut state = self.state.lock().unwrap();
        if *self.cancel_at.lock().unwrap() == Some(phase) {
            *state = "canceled".into();
        }
        Ok((*state != "claimed").then(|| state.clone()))
    }

    fn complete(&self, _launch_id: &str, outcome: &Outcome) -> Result<Completed, CallError> {
        let mut failing = self.fail_complete.lock().unwrap();
        if *failing > 0 {
            *failing -= 1;
            return Err(CallError::Transient(anyhow!("lost response")));
        }
        self.completions.lock().unwrap().push(outcome.clone());
        let mut state = self.state.lock().unwrap();
        if *state == "claimed" {
            *state = outcome.outcome.clone();
            Ok(Completed::Settled(state.clone()))
        } else if *state == outcome.outcome {
            Ok(Completed::Settled(state.clone()))
        } else {
            Ok(Completed::Conflict(state.clone()))
        }
    }
}

#[derive(Default)]
struct FakeStarter {
    starts: Mutex<Vec<(PathBuf, String, Option<String>)>>,
    unavailable: bool,
    /// Die mid-start: the prompt may or may not have been sent.
    panic: bool,
    /// The tab is created, then typing the prompt fails.
    send_fails: bool,
}

impl Starter for FakeStarter {
    fn available(&self, _agent: &str) -> bool {
        !self.unavailable
    }

    fn start(&self, cwd: &Path, claim: &Claim, title: &str) -> Result<(String, String), StartError> {
        if self.panic {
            panic!("the runtime died while starting the agent");
        }
        if self.send_fails {
            return Err(StartError::SendFailed { session_id: "session-1".into(), tab_id: "tab-1".into(), error: anyhow!("pty write failed") });
        }
        self.starts.lock().unwrap().push((cwd.to_path_buf(), title.to_string(), claim.prompt.as_ref().map(|p| p.to_string())));
        Ok(("session-1".into(), "tab-1".into()))
    }
}

fn claim(repositories: Vec<Repository>) -> Claim {
    Claim {
        launch_id: "launch_1".into(),
        state: "deliver".into(),
        redelivery: false,
        work_branch: "terminalx/fix-login-3f9a2c1b7d4e".into(),
        title: Some("Fix the login".into()),
        agent: "claude".into(),
        model: Some("sonnet".into()),
        effort: None,
        mode: Some("acceptEdits".into()),
        prompt: Some("Fix the login\nand add a test".into()),
        repositories,
    }
}

fn make(dir: &Path, api: Arc<FakeApi>, starter: Arc<FakeStarter>, incarnation: &str) -> Launcher {
    Launcher {
        api,
        starter,
        checkout: Arc::new(GitCheckout),
        store: Store::open(dir),
        incarnation: incarnation.into(),
        root: dir.join("workspace"),
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A bare remote with `main` and `feature`, cloned to `path` on `main`.
fn repository(root: &Path, name: &str) -> Repository {
    let remote = root.join(format!("{name}.git"));
    let seed = root.join(format!("{name}-seed"));
    std::fs::create_dir_all(&seed).unwrap();
    git(root, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&seed, &["init", "-q"]);
    std::fs::write(seed.join("README.md"), format!("{name}\n")).unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "init"]);
    git(&seed, &["switch", "-qc", "feature"]);
    std::fs::write(seed.join("FEATURE.md"), "feature\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "feature"]);
    git(&seed, &["push", "-q", remote.to_str().unwrap(), "main", "feature"]);
    let path = root.join("repos").join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    git(root, &["clone", "-q", "-b", "main", remote.to_str().unwrap(), path.to_str().unwrap()]);
    Repository { owner: "acme".into(), name: name.into(), path: path.to_string_lossy().into_owned(), base_ref: None }
}

#[test]
fn launches_once_on_the_work_branch_of_every_repository() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = repository(dir.path(), "app");
    app.base_ref = Some("feature".into());
    let lib = repository(dir.path(), "lib");
    let api = FakeApi::new(Some(claim(vec![app.clone(), lib.clone()])));
    let starter = Arc::new(FakeStarter::default());
    let launcher = make(dir.path(), api.clone(), starter.clone(), "incarnation-aaaaaaaaaaaa");

    assert_eq!(launcher.pass().unwrap(), Pass::Settled("started".into()));
    assert_eq!(*api.phases.lock().unwrap(), ["syncing-repository", "starting-agent"]);
    let starts = starter.starts.lock().unwrap().clone();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0].0, PathBuf::from(&app.path), "the agent starts in the primary repository");
    assert_eq!(starts[0].1, "Fix the login");
    assert_eq!(starts[0].2.as_deref(), Some("Fix the login\nand add a test"));

    // The work branch is made from the base ref in the primary repository and
    // from the default branch in the other.
    let branch = "terminalx/fix-login-3f9a2c1b7d4e";
    assert_eq!(git(Path::new(&app.path), &["branch", "--show-current"]), branch);
    assert_eq!(git(Path::new(&app.path), &["rev-parse", branch]), git(Path::new(&app.path), &["rev-parse", "origin/feature"]));
    assert_eq!(git(Path::new(&lib.path), &["branch", "--show-current"]), branch);
    assert_eq!(git(Path::new(&lib.path), &["rev-parse", branch]), git(Path::new(&lib.path), &["rev-parse", "origin/main"]));
    let completed = api.completions.lock().unwrap().clone();
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].outcome, "started");
    assert_eq!(completed[0].tab_id.as_deref(), Some("tab-1"));
    assert_eq!(completed[0].branches.len(), 2);
    assert_eq!(completed[0].branches[0].head, git(Path::new(&app.path), &["rev-parse", "HEAD"]));

    // Settled: another pass (a restart) never starts anything again.
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("started".into()));
    assert_eq!(starter.starts.lock().unwrap().len(), 1);
}

#[test]
fn a_lost_completion_is_reported_again_from_the_stored_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let api = FakeApi::new(Some(claim(Vec::new())));
    *api.fail_complete.lock().unwrap() = 1;
    let starter = Arc::new(FakeStarter::default());
    let launcher = make(dir.path(), api.clone(), starter.clone(), "incarnation-aaaaaaaaaaaa");

    assert!(launcher.pass().is_err(), "the completion was lost in transit");
    // The redelivery (same incarnation) is answered from launch.json.
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("started".into()));
    assert_eq!(starter.starts.lock().unwrap().len(), 1, "the prompt is sent once");
    assert_eq!(starter.starts.lock().unwrap()[0].0, dir.path().join("workspace"), "no repositories: the project root");
    // A restart after that: the settled state, nothing started.
    let restarted = super::Launcher { store: Store::open(dir.path()), ..launcher };
    assert_eq!(restarted.pass().unwrap(), Pass::Settled("started".into()));
    assert_eq!(starter.starts.lock().unwrap().len(), 1);
}

#[test]
fn dying_mid_start_is_outcome_unknown_and_never_resent() {
    let dir = tempfile::tempdir().unwrap();
    let api = FakeApi::new(Some(claim(Vec::new())));
    let dying = Arc::new(FakeStarter { panic: true, ..FakeStarter::default() });
    let first = make(dir.path(), api.clone(), dying, "incarnation-aaaaaaaaaaaa");
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| first.pass())).is_err());

    let starter = Arc::new(FakeStarter::default());
    let restarted = make(dir.path(), api.clone(), starter.clone(), "incarnation-aaaaaaaaaaaa");
    assert_eq!(restarted.pass().unwrap(), Pass::Settled("outcome-unknown".into()));
    assert!(starter.starts.lock().unwrap().is_empty(), "never sent a second time");
    let completed = api.completions.lock().unwrap().clone();
    assert_eq!(completed[0].category.as_deref(), Some("runtime-interrupted"));
}

#[test]
fn a_new_receipt_store_never_gets_the_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let api = FakeApi::new(Some(claim(Vec::new())));
    // Claimed by a runtime whose disk is gone.
    api.claim("incarnation-old-old-old-old").unwrap();
    let starter = Arc::new(FakeStarter::default());
    let launcher = make(dir.path(), api.clone(), starter.clone(), "incarnation-new-new-new-new");
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("outcome-unknown".into()));
    assert!(starter.starts.lock().unwrap().is_empty());
}

#[test]
fn failures_are_reported_with_their_category() {
    let dir = tempfile::tempdir().unwrap();
    // Not installed: the repositories are ready, the agent never starts.
    let app = repository(dir.path(), "app");
    let api = FakeApi::new(Some(claim(vec![app])));
    let starter = Arc::new(FakeStarter { unavailable: true, ..FakeStarter::default() });
    let launcher = make(&dir.path().join("a"), api.clone(), starter.clone(), "incarnation-aaaaaaaaaaaa");
    std::fs::create_dir_all(dir.path().join("a")).unwrap();
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("failed".into()));
    assert_eq!(api.completions.lock().unwrap()[0].category.as_deref(), Some("agent-unavailable"));

    // A base ref the remote does not have.
    let mut missing = repository(dir.path(), "other");
    missing.base_ref = Some("does-not-exist".into());
    let api = FakeApi::new(Some(claim(vec![missing])));
    let starter = Arc::new(FakeStarter::default());
    std::fs::create_dir_all(dir.path().join("b")).unwrap();
    let launcher = make(&dir.path().join("b"), api.clone(), starter.clone(), "incarnation-aaaaaaaaaaaa");
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("failed".into()));
    assert_eq!(api.completions.lock().unwrap()[0].category.as_deref(), Some("repository-sync-failed"));
    assert!(starter.starts.lock().unwrap().is_empty());

    // A branch name git would misread is refused before git sees it.
    let mut bad = claim(Vec::new());
    bad.work_branch = "--upload-pack=touch".into();
    let api = FakeApi::new(Some(bad));
    std::fs::create_dir_all(dir.path().join("c")).unwrap();
    let launcher = make(&dir.path().join("c"), api.clone(), starter.clone(), "incarnation-aaaaaaaaaaaa");
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("failed".into()));
    assert_eq!(api.completions.lock().unwrap()[0].category.as_deref(), Some("payload-invalid"));
}

#[test]
fn an_existing_work_branch_is_reused_by_the_same_workspace_not_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let app = repository(dir.path(), "app");
    let branch = "terminalx/fix-login-3f9a2c1b7d4e";
    let path = Path::new(&app.path);
    GitCheckout.prepare(&app, branch).unwrap();
    std::fs::write(path.join("work.txt"), "agent work\n").unwrap();
    git(path, &["add", "."]);
    git(path, &["commit", "-qm", "agent work"]);
    let head = git(path, &["rev-parse", "HEAD"]);
    git(path, &["switch", "-q", "main"]);
    // A later attempt (a retried create on the same disk) lands on the same
    // branch with its commits, not a fresh one from the base.
    let prepared = GitCheckout.prepare(&app, branch).unwrap();
    assert_eq!(prepared.head, head);
    assert_eq!(git(path, &["branch", "--show-current"]), branch);
}

#[test]
fn nothing_to_launch_without_an_intent() {
    let dir = tempfile::tempdir().unwrap();
    let starter = Arc::new(FakeStarter::default());
    let launcher = make(dir.path(), FakeApi::new(None), starter.clone(), "incarnation-aaaaaaaaaaaa");
    assert_eq!(launcher.pass().unwrap(), Pass::None);
    assert!(starter.starts.lock().unwrap().is_empty());
}

#[test]
fn branch_names_follow_git_rules() {
    for good in ["main", "feature/fast-launch", "terminalx/fix-login-3f9a2c1b7d4e", "release-1.2"] {
        assert!(valid_branch(good), "{good}");
    }
    for bad in ["", "-x", "/a", "a/", "a..b", "a//b", "a.lock", "a/.b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "@", "a@{1}", ".a", "a."] {
        assert!(!valid_branch(bad), "{bad}");
    }
    assert!(!valid_repository_path("relative/path"));
    assert!(!valid_repository_path("/home/repos/../etc"));
    assert!(valid_repository_path("/home/repos/acme/app"));
}

#[test]
fn a_create_canceled_while_preparing_never_starts_the_agent() {
    let dir = tempfile::tempdir().unwrap();
    let api = FakeApi::new(Some(claim(Vec::new())));
    // The user cancels after the claim, while the repositories are prepared.
    *api.cancel_at.lock().unwrap() = Some("starting-agent");
    let starter = Arc::new(FakeStarter::default());
    let launcher = make(dir.path(), api.clone(), starter.clone(), "incarnation-aaaaaaaaaaaa");
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("canceled".into()));
    assert!(starter.starts.lock().unwrap().is_empty(), "nothing started for a canceled intent");
    assert!(api.completions.lock().unwrap().is_empty());
}

#[test]
fn a_prompt_that_failed_to_send_after_the_tab_exists_is_outcome_unknown_with_the_tab() {
    let dir = tempfile::tempdir().unwrap();
    let api = FakeApi::new(Some(claim(Vec::new())));
    let starter = Arc::new(FakeStarter { send_fails: true, ..FakeStarter::default() });
    let launcher = make(dir.path(), api.clone(), starter, "incarnation-aaaaaaaaaaaa");
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("outcome-unknown".into()));
    let completed = api.completions.lock().unwrap()[0].clone();
    assert_eq!(completed.category.as_deref(), Some("prompt-send-failed"));
    assert_eq!(completed.tab_id.as_deref(), Some("tab-1"));
}

/// `launch.json` keeps its snake_case `launch_id` (see `Record`): a file an
/// earlier runtime wrote must still be found, or the prompt could go twice.
#[test]
fn launch_json_keeps_its_on_disk_shape() {
    let applying = serde_json::to_value(Record::Applying { launch_id: "launch_1".into() }).unwrap();
    assert_eq!(applying, serde_json::json!({ "stage": "applying", "launch_id": "launch_1" }));
    let done = Record::Done {
        launch_id: "launch_1".into(),
        outcome: Outcome { outcome: "started".into(), category: None, session_id: Some("s1".into()), tab_id: Some("t1".into()), branches: vec![] },
    };
    assert_eq!(
        serde_json::to_value(&done).unwrap(),
        serde_json::json!({ "stage": "done", "launch_id": "launch_1", "outcome": { "outcome": "started", "sessionId": "s1", "tabId": "t1", "branches": [] } })
    );
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(FILE), r#"{"stage":"done","launch_id":"launch_1","outcome":{"outcome":"started","sessionId":"s1","tabId":"t1","branches":[]}}"#).unwrap();
    assert_eq!(Store::open(dir.path()).get("launch_1"), Some(done));
}

/// A cloud launch that names no mode — the field absent from the claim, or
/// blank — starts its tab in the default launch mode, bypass, exactly as a
/// desktop session does. A named mode is kept.
#[test]
fn a_claimed_launch_without_a_mode_starts_in_bypass() {
    let absent: Claim = serde_json::from_value(serde_json::json!({
        "launchId": "launch_1", "state": "deliver", "workBranch": "terminalx/x", "agent": "claude"
    }))
    .unwrap();
    assert_eq!(absent.mode, None);
    let mut blank = claim(Vec::new());
    blank.mode = Some("  ".into());
    for c in [absent, blank] {
        let tab = crate::session_ops::new_tab_entry(&new_tab(&c));
        assert_eq!(tab.permission_mode, "bypassPermissions");
        assert_eq!(crate::harness::claude::normalize_mode(&tab.permission_mode), "bypassPermissions");
    }
    let named = crate::session_ops::new_tab_entry(&new_tab(&claim(Vec::new())));
    assert_eq!(named.permission_mode, "acceptEdits");
}

#[test]
fn a_blank_project_starts_in_a_git_initialised_folder_on_its_work_branch() {
    let dir = tempfile::tempdir().unwrap();
    let api = FakeApi::new(Some(claim(Vec::new())));
    let starter = Arc::new(FakeStarter::default());
    let launcher = make(dir.path(), api.clone(), starter.clone(), "incarnation-aaaaaaaaaaaa");
    let root = dir.path().join("workspace");

    assert_eq!(launcher.pass().unwrap(), Pass::Settled("started".into()));
    let starts = starter.starts.lock().unwrap().clone();
    assert_eq!(starts[0].0, root, "a launch with no repository starts in the workspace folder");
    // A repository on the work branch with a first commit, so Changes, Git and worktrees work.
    assert_eq!(git(&root, &["branch", "--show-current"]), "terminalx/fix-login-3f9a2c1b7d4e");
    assert!(!git(&root, &["rev-parse", "HEAD"]).is_empty());
    assert_eq!(git(&root, &["status", "--porcelain"]), "");
    std::fs::write(root.join("notes.md"), "hello\n").unwrap();
    assert_eq!(git(&root, &["status", "--porcelain"]), "?? notes.md");
    git(&root, &["worktree", "add", "-q", "-b", "second", dir.path().join("second").to_str().unwrap()]);
    // Nothing about the folder is reported as a repository branch.
    assert!(api.completions.lock().unwrap()[0].branches.is_empty());
}

#[test]
fn a_folder_that_already_holds_repositories_is_never_initialised() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir_all(root.join("images/app")).unwrap();
    git(&root.join("images/app"), &["init", "-q"]);
    assert!(!init_blank_repository(&root, "main").unwrap());
    assert!(!root.join(".git").exists());

    let repo = dir.path().join("already");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    assert!(!init_blank_repository(&repo, "main").unwrap());

    let blank = dir.path().join("blank");
    assert!(init_blank_repository(&blank, "main").unwrap());
    // Once set up, it is a repository: a second call changes nothing.
    assert!(!init_blank_repository(&blank, "main").unwrap());
    assert_eq!(git(&blank, &["rev-list", "--count", "HEAD"]), "1");
}

/// A session titled by `title_of`, with one unnamed tab whose log holds the prompt.
fn titled_session(id: &str, title: &str, prompt: &str) {
    let session: crate::store::index::SessionEntry = serde_json::from_value(json!({
        "id": id, "projectPath": "/project", "cwd": "/project", "title": title,
        "created": "before", "modified": "before",
        "tabs": [{ "id": "tab", "harness": "claude", "created": "before", "modified": "before" }]
    }))
    .unwrap();
    crate::store::index::update(|sessions| {
        sessions.push(session);
        Ok(())
    })
    .unwrap();
    let log = crate::store::log_path(id, "tab").unwrap();
    crate::store::append_line(&log, &json!({ "payload": { "type": "user_message", "text": prompt } }).to_string()).unwrap();
}

#[test]
fn a_launched_session_and_its_first_tab_get_the_same_title() {
    let _home = crate::store::temp_home();
    let long = "refactor the workspace catalog so that every organization is loaded lazily and cached between launches";
    let cases = [
        ("echo:hello one", "Echo:hello one"),
        ("can you please fix the login redirect? Then add tests.", "Fix the login redirect"),
        (long, "Refactor the workspace catalog so that every"),
        ("42 is the answer, check it", "42 is the answer, check it"),
        ("# tidy the readme\nand nothing else", "Tidy the readme"),
    ];
    for (index, (prompt, expected)) in cases.into_iter().enumerate() {
        // The server's title is the prompt's first line, as typed.
        let claim = Claim { title: prompt.lines().next().map(str::to_string), prompt: Some(prompt.into()), ..claim(Vec::new()) };
        let title = title_of(&claim);
        assert_eq!(title, expected, "{prompt}");
        let id = format!("session-{index}");
        titled_session(&id, &title, prompt);
        let named = crate::store::conversation_titles::name_tab(&id, "tab").unwrap().unwrap();
        assert_eq!(named.tab("tab").unwrap().title.as_deref(), Some(named.title.as_str()), "{prompt}");
    }
}

#[test]
fn a_launch_without_a_usable_prompt_keeps_the_servers_title() {
    let named = Claim { title: Some("my workspace".into()), prompt: None, ..claim(Vec::new()) };
    assert_eq!(title_of(&named), "my workspace");
    // Nothing to derive from: the tab stays unnamed and goes by this title.
    let wordless = Claim { title: Some("???".into()), prompt: Some("???".into()), ..claim(Vec::new()) };
    assert_eq!(title_of(&wordless), "???");
    let untitled = Claim { title: None, prompt: None, ..claim(Vec::new()) };
    assert_eq!(title_of(&untitled), untitled.work_branch);
}

#[test]
fn naming_the_tab_leaves_a_renamed_session_alone() {
    let _home = crate::store::temp_home();
    let prompt = "echo:hello one";
    titled_session("renamed", "echo:hello one", prompt);
    crate::store::index::update(|sessions| {
        sessions[0].title = "My own name".into();
        Ok(())
    })
    .unwrap();
    let named = crate::store::conversation_titles::name_tab("renamed", "tab").unwrap().unwrap();
    assert_eq!(named.title, "My own name");
    assert_eq!(named.tab("tab").unwrap().title.as_deref(), Some("Echo:hello one"));
    // A session stored before this change keeps its title as typed, too.
    titled_session("older", "echo:hello two", "echo:hello two");
    let older = crate::store::conversation_titles::name_tab("older", "tab").unwrap().unwrap();
    assert_eq!(older.title, "echo:hello two");
}
