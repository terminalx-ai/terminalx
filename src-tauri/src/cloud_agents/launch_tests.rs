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
        checkout: Arc::new(GitCheckout::default()),
        store: Store::open(dir),
        incarnation: incarnation.into(),
        root: dir.join("workspace"),
        cancel_poll: CANCEL_POLL,
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
    Repository { owner: "acme".into(), name: name.into(), path: path.to_string_lossy().into_owned(), base_ref: None, clone: None }
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
    GitCheckout::default().prepare(&app, branch).unwrap();
    std::fs::write(path.join("work.txt"), "agent work\n").unwrap();
    git(path, &["add", "."]);
    git(path, &["commit", "-qm", "agent work"]);
    let head = git(path, &["rev-parse", "HEAD"]);
    git(path, &["switch", "-q", "main"]);
    // A later attempt (a retried create on the same disk) lands on the same
    // branch with its commits, not a fresh one from the base.
    let prepared = GitCheckout::default().prepare(&app, branch).unwrap();
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

/// Bare remotes `acme/<name>.git` (`main` and `feature`) under `remotes`,
/// nothing checked out: what a workspace with no Environment image starts with.
fn remotes(root: &Path, names: &[&str]) -> PathBuf {
    let base = root.join("remotes");
    for name in names {
        let remote = base.join("acme").join(format!("{name}.git"));
        let seed = root.join(format!("{name}-seed"));
        std::fs::create_dir_all(&seed).unwrap();
        std::fs::create_dir_all(remote.parent().unwrap()).unwrap();
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
    }
    base
}

fn to_clone(root: &Path, name: &str, base_ref: Option<&str>) -> Repository {
    Repository {
        owner: "acme".into(),
        name: name.into(),
        path: root.join(name).to_string_lossy().into_owned(),
        base_ref: base_ref.map(str::to_string),
        clone: Some(CloneSource { provider: "github".into() }),
    }
}

/// A launcher whose project root is `dir/<workspace>` and which clones from `remote`.
fn cloning(dir: &Path, workspace: &str, remote: &Path, api: Arc<FakeApi>, starter: Arc<FakeStarter>) -> Launcher {
    let state = dir.join(format!("{workspace}-state"));
    std::fs::create_dir_all(&state).unwrap();
    Launcher {
        api,
        starter,
        checkout: Arc::new(GitCheckout::from_remote(remote.to_str().unwrap())),
        store: Store::open(&state),
        incarnation: "incarnation-aaaaaaaaaaaa".into(),
        root: dir.join(workspace),
        cancel_poll: CANCEL_POLL,
    }
}

const WORK_BRANCH: &str = "terminalx/fix-login-3f9a2c1b7d4e";

#[test]
fn a_workspace_without_an_image_clones_its_repositories_at_their_base_branch() {
    let dir = tempfile::tempdir().unwrap();
    let remote = remotes(dir.path(), &["app", "lib"]);
    let root = dir.path().join("workspace");
    let (app, lib) = (to_clone(&root, "app", Some("feature")), to_clone(&root, "lib", None));
    let api = FakeApi::new(Some(claim(vec![app.clone(), lib.clone()])));
    let starter = Arc::new(FakeStarter::default());
    let launcher = cloning(dir.path(), "workspace", &remote, api.clone(), starter.clone());

    assert_eq!(launcher.pass().unwrap(), Pass::Settled("started".into()));
    assert_eq!(*api.phases.lock().unwrap(), ["syncing-repository", "starting-agent"]);
    let (app_path, lib_path) = (Path::new(&app.path), Path::new(&lib.path));
    // Its own branch, cut from the chosen base in one and the default branch in the other.
    assert_eq!(git(app_path, &["branch", "--show-current"]), WORK_BRANCH);
    assert_eq!(git(app_path, &["rev-parse", "HEAD"]), git(app_path, &["rev-parse", "origin/feature"]));
    assert!(app_path.join("FEATURE.md").exists());
    assert_eq!(git(lib_path, &["branch", "--show-current"]), WORK_BRANCH);
    assert_eq!(git(lib_path, &["rev-parse", "HEAD"]), git(lib_path, &["rev-parse", "origin/main"]));
    assert!(!lib_path.join("FEATURE.md").exists());
    // The remote is the plain repository URL: nothing else was ever put in it.
    assert_eq!(git(app_path, &["remote", "get-url", "origin"]), format!("{}/acme/app.git", remote.display()));
    // The project root itself was not made a blank repository, and no staging directory is left.
    assert!(!root.join(".git").exists());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
    let starts = starter.starts.lock().unwrap().clone();
    assert_eq!(starts[0].0, PathBuf::from(&app.path), "the agent starts in the primary repository");
    let completed = api.completions.lock().unwrap().clone();
    assert_eq!(completed[0].branches.iter().map(|branch| branch.branch.as_str()).collect::<Vec<_>>(), [WORK_BRANCH, WORK_BRANCH]);
    assert_eq!(completed[0].branches[0].path, app.path);
}

#[test]
fn two_workspaces_from_one_repository_edit_the_same_file_independently() {
    let dir = tempfile::tempdir().unwrap();
    let remote = remotes(dir.path(), &["app"]);
    let mut paths = Vec::new();
    for (workspace, branch) in [("one", "terminalx/one-aaaaaaaaaaaa"), ("two", "terminalx/two-bbbbbbbbbbbb")] {
        let app = to_clone(&dir.path().join(workspace), "app", Some("main"));
        let mut intent = claim(vec![app.clone()]);
        intent.work_branch = branch.into();
        let launcher = cloning(dir.path(), workspace, &remote, FakeApi::new(Some(intent)), Arc::new(FakeStarter::default()));
        assert_eq!(launcher.pass().unwrap(), Pass::Settled("started".into()));
        let path = PathBuf::from(&app.path);
        assert_eq!(git(&path, &["branch", "--show-current"]), branch);
        std::fs::write(path.join("README.md"), format!("{workspace}\n")).unwrap();
        git(&path, &["commit", "-qam", workspace]);
        paths.push(path);
    }
    assert_eq!(std::fs::read_to_string(paths[0].join("README.md")).unwrap(), "one\n");
    assert_eq!(std::fs::read_to_string(paths[1].join("README.md")).unwrap(), "two\n");
    assert_ne!(git(&paths[0], &["rev-parse", "HEAD"]), git(&paths[1], &["rev-parse", "HEAD"]));
    assert!(git(&paths[1], &["branch", "--list", "terminalx/one-aaaaaaaaaaaa"]).is_empty());
}

#[test]
fn a_retry_keeps_the_clone_it_already_has_and_clears_its_own_leftover() {
    let dir = tempfile::tempdir().unwrap();
    let remote = remotes(dir.path(), &["app"]);
    let root = dir.path().join("workspace");
    let app = to_clone(&root, "app", Some("main"));
    let checkout = GitCheckout::from_remote(remote.to_str().unwrap());
    // A clone that died halfway left its staging directory behind.
    std::fs::create_dir_all(root.join(".terminalx-clone-app").join("junk")).unwrap();
    checkout.clone_missing(&app, CLONE_BUDGET, &|| false).unwrap();
    assert!(!root.join(".terminalx-clone-app").exists());
    checkout.prepare(&app, WORK_BRANCH).unwrap();
    std::fs::write(Path::new(&app.path).join("work.txt"), "work\n").unwrap();
    git(Path::new(&app.path), &["add", "."]);
    git(Path::new(&app.path), &["commit", "-qm", "work"]);
    let head = git(Path::new(&app.path), &["rev-parse", "HEAD"]);

    // The next attempt neither clones again nor resets the branch.
    checkout.clone_missing(&app, CLONE_BUDGET, &|| false).unwrap();
    assert_eq!(checkout.prepare(&app, WORK_BRANCH).unwrap().head, head);
    assert!(Path::new(&app.path).join("work.txt").exists());

    // A checkout of something else at that path is refused, not replaced.
    let other = Repository { name: "other".into(), ..app.clone() };
    assert!(matches!(checkout.clone_missing(&other, CLONE_BUDGET, &|| false), Err(CloneError::Failed { category: "repository-path-occupied", .. })));
    assert!(Path::new(&app.path).join("work.txt").exists());
}

#[test]
fn a_clone_that_cannot_be_made_fails_the_launch_and_deletes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let remote = remotes(dir.path(), &["app"]);
    let failed = |workspace: &str, repository: Repository| {
        let api = FakeApi::new(Some(claim(vec![repository])));
        let starter = Arc::new(FakeStarter::default());
        let launcher = cloning(dir.path(), workspace, &remote, api.clone(), starter.clone());
        assert_eq!(launcher.pass().unwrap(), Pass::Settled("failed".into()));
        assert!(starter.starts.lock().unwrap().is_empty(), "the agent never starts without its repository");
        assert_eq!(*api.phases.lock().unwrap(), ["syncing-repository"]);
        let category = api.completions.lock().unwrap()[0].category.clone();
        category.unwrap()
    };

    // A repository the workspace cannot reach, and a base branch it does not have.
    for (workspace, name, base, category) in [("a", "missing", None, "repository-clone-failed"), ("a2", "app", Some("does-not-exist"), "repository-branch-not-found")] {
        let root = dir.path().join(workspace);
        assert_eq!(failed(workspace, to_clone(&root, name, base)), category);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0, "nothing half-cloned is left");
    }

    // Files already at the path are someone's: the launch fails and they stay.
    let root = dir.path().join("b");
    std::fs::create_dir_all(root.join("app")).unwrap();
    std::fs::write(root.join("app").join("notes.txt"), "mine\n").unwrap();
    assert_eq!(failed("b", to_clone(&root, "app", None)), "repository-path-occupied");
    assert_eq!(std::fs::read_to_string(root.join("app").join("notes.txt")).unwrap(), "mine\n");
}

#[test]
fn a_clone_that_runs_out_of_time_is_stopped_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let remote = remotes(dir.path(), &["app"]);
    let root = dir.path().join("workspace");
    let app = to_clone(&root, "app", None);
    let error = GitCheckout::from_remote(remote.to_str().unwrap()).clone_missing(&app, Duration::ZERO, &|| false).unwrap_err();
    assert!(matches!(error, CloneError::Failed { category: "repository-clone-timed-out", .. }), "{error:?}");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0, "no staging directory and no half clone");
    // With time, the same clone is made.
    GitCheckout::from_remote(remote.to_str().unwrap()).clone_missing(&app, CLONE_BUDGET, &|| false).unwrap();
    assert!(Path::new(&app.path).join("README.md").exists());
}

#[test]
fn a_launch_counts_as_work_while_it_runs() {
    struct Watching(Mutex<Vec<bool>>);
    impl Checkout for Watching {
        fn clone_missing(&self, _repository: &Repository, within: Duration, _canceled: &dyn Fn() -> bool) -> std::result::Result<(), CloneError> {
            // Seen from inside the launch: the activity reporter would report a running turn.
            self.0.lock().unwrap().push(crate::cloud_activity::launches() >= 1 && within <= CLONE_BUDGET && within > Duration::ZERO);
            Ok(())
        }
        fn prepare(&self, repository: &Repository, work_branch: &str) -> Result<Branch> {
            Ok(Branch { path: repository.path.clone(), branch: work_branch.into(), head: "0".repeat(40) })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    let checkout = Arc::new(Watching(Mutex::new(Vec::new())));
    let launcher = Launcher {
        api: FakeApi::new(Some(claim(vec![to_clone(&root, "app", None)]))),
        starter: Arc::new(FakeStarter::default()),
        checkout: checkout.clone(),
        store: Store::open(dir.path()),
        incarnation: "incarnation-aaaaaaaaaaaa".into(),
        root,
        cancel_poll: CANCEL_POLL,
    };
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("started".into()));
    assert_eq!(*checkout.0.lock().unwrap(), [true]);
}

#[test]
fn a_clone_plan_that_leaves_the_project_root_or_names_no_github_repository_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let remote = remotes(dir.path(), &["app"]);
    let root = dir.path().join("workspace");
    let good = to_clone(&root, "app", None);
    let bad = [
        Repository { path: dir.path().join("elsewhere").join("app").to_string_lossy().into_owned(), ..good.clone() },
        Repository { path: root.join("nested").join("app").to_string_lossy().into_owned(), ..good.clone() },
        Repository { path: root.to_string_lossy().into_owned(), ..good.clone() },
        Repository { owner: "..".into(), ..good.clone() },
        Repository { owner: "acme/evil".into(), ..good.clone() },
        Repository { name: "app.git?x=y".into(), ..good.clone() },
        Repository { name: String::new(), ..good.clone() },
        Repository { clone: Some(CloneSource { provider: "gitlab".into() }), ..good.clone() },
    ];
    for repository in bad {
        let api = FakeApi::new(Some(claim(vec![repository.clone()])));
        let launcher = cloning(dir.path(), "workspace", &remote, api.clone(), Arc::new(FakeStarter::default()));
        assert_eq!(launcher.pass().unwrap(), Pass::Settled("failed".into()), "{repository:?}");
        assert_eq!(api.completions.lock().unwrap()[0].category.as_deref(), Some("payload-invalid"), "{repository:?}");
        assert!(api.phases.lock().unwrap().is_empty(), "refused before git runs");
    }
    assert!(!root.exists() && !dir.path().join("elsewhere").exists());
}

#[test]
fn the_production_clone_url_is_github_with_no_credential_in_it() {
    let repository = to_clone(Path::new("/var/lib/terminalx/workspace"), "app", None);
    assert_eq!(GitCheckout::default().clone_url(&repository), "https://github.com/acme/app.git");
}

#[test]
fn the_claim_declares_that_this_runtime_clones_and_reads_the_plan() {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = Vec::new();
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line.trim().is_empty() {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
            head.push(line.trim().to_ascii_lowercase());
        }
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).unwrap();
        let reply = json!({ "v": 1, "launch": {
            "launchId": "launch_1", "state": "deliver", "redelivery": false, "workBranch": WORK_BRANCH, "title": "t", "agent": "claude",
            "repositories": [
                { "owner": "acme", "name": "app", "path": "/var/lib/terminalx/workspace/app", "ref": "main", "clone": { "provider": "github" } },
                { "owner": "acme", "name": "lib", "path": "/home/repos/acme/lib" }
            ]
        } })
        .to_string();
        write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).unwrap();
        (head, String::from_utf8(body).unwrap())
    });
    let api = HttpMailboxApi::new(&origin, Arc::new(|| Some(zeroize::Zeroizing::new("runtime-credential".to_string()))));
    let claimed = api.claim("incarnation-aaaaaaaaaaaa").unwrap().unwrap();
    let (head, body) = server.join().unwrap();
    assert!(head.contains(&"x-terminalx-cloud-workspace-runtime-capabilities: launch-clone-v1".to_string()), "{head:?}");
    // The body stays exactly what a server from before this accepts.
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({ "v": 1, "storageIncarnationId": "incarnation-aaaaaaaaaaaa" }));
    assert_eq!(claimed.repositories[0].clone, Some(CloneSource { provider: "github".into() }));
    assert_eq!(claimed.repositories[0].base_ref.as_deref(), Some("main"));
    assert_eq!(claimed.repositories[1].clone, None);
}

#[test]
fn a_create_canceled_while_git_runs_kills_it_and_starts_nothing() {
    // Git itself: told to stop, it is killed and leaves no staging directory.
    let dir = tempfile::tempdir().unwrap();
    let remote = remotes(dir.path(), &["app"]);
    let root = dir.path().join("workspace");
    let app = to_clone(&root, "app", None);
    let stopped = GitCheckout::from_remote(remote.to_str().unwrap()).clone_missing(&app, CLONE_BUDGET, &|| true);
    assert!(matches!(stopped, Err(CloneError::Canceled)), "{stopped:?}");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);

    // The launcher: the server settles the create while the clone runs.
    struct Slow(Arc<FakeApi>);
    impl Checkout for Slow {
        fn clone_missing(&self, _repository: &Repository, _within: Duration, canceled: &dyn Fn() -> bool) -> std::result::Result<(), CloneError> {
            assert!(!canceled(), "not canceled yet");
            *self.0.state.lock().unwrap() = "canceled".into();
            for _ in 0..200 {
                if canceled() {
                    return Err(CloneError::Canceled);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            panic!("the launcher never noticed the cancel");
        }
        fn prepare(&self, _repository: &Repository, _work_branch: &str) -> Result<Branch> {
            panic!("a canceled launch prepares nothing");
        }
    }
    let api = FakeApi::new(Some(claim(vec![app])));
    let starter = Arc::new(FakeStarter::default());
    let launcher = Launcher {
        api: api.clone(),
        starter: starter.clone(),
        checkout: Arc::new(Slow(api.clone())),
        store: Store::open(dir.path()),
        incarnation: "incarnation-aaaaaaaaaaaa".into(),
        root,
        cancel_poll: Duration::ZERO,
    };
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("canceled".into()));
    assert!(starter.starts.lock().unwrap().is_empty());
    assert!(api.completions.lock().unwrap().is_empty(), "a canceled launch reports no outcome");
}

#[test]
fn an_unreachable_api_is_not_a_cancel() {
    struct Asking;
    impl Checkout for Asking {
        fn clone_missing(&self, _repository: &Repository, _within: Duration, canceled: &dyn Fn() -> bool) -> std::result::Result<(), CloneError> {
            assert!(!canceled() && !canceled());
            Ok(())
        }
        fn prepare(&self, repository: &Repository, work_branch: &str) -> Result<Branch> {
            Ok(Branch { path: repository.path.clone(), branch: work_branch.into(), head: "0".repeat(40) })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    let api = FakeApi::new(Some(claim(vec![to_clone(&root, "app", None)])));
    let launcher = Launcher {
        api: api.clone(),
        starter: Arc::new(FakeStarter::default()),
        checkout: Arc::new(Asking),
        store: Store::open(dir.path()),
        incarnation: "incarnation-aaaaaaaaaaaa".into(),
        root,
        cancel_poll: Duration::ZERO,
    };
    assert_eq!(launcher.pass().unwrap(), Pass::Settled("started".into()));
}

#[test]
fn an_empty_repository_is_reported_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    let remote = dir.path().join("remotes");
    std::fs::create_dir_all(remote.join("acme")).unwrap();
    git(dir.path(), &["init", "-q", "--bare", remote.join("acme").join("empty.git").to_str().unwrap()]);
    let root = dir.path().join("workspace");
    let error = GitCheckout::from_remote(remote.to_str().unwrap()).clone_missing(&to_clone(&root, "empty", None), CLONE_BUDGET, &|| false).unwrap_err();
    assert!(matches!(error, CloneError::Failed { category: "repository-empty", .. }), "{error:?}");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn a_failed_clone_is_named_by_what_git_said() {
    for (stderr, category) in [
        ("fatal: write error: No space left on device\nfatal: fetch-pack: invalid index-pack output", "workspace-disk-full"),
        ("error: unable to write file x: Disk quota exceeded", "workspace-disk-full"),
        ("warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin", "repository-branch-not-found"),
        ("error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds", "repository-clone-timed-out"),
        ("fatal: Authentication failed for 'https://github.com/acme/app.git/'", "repository-access-denied"),
        ("fatal: could not read Username for 'https://github.com': terminal prompts disabled", "repository-access-denied"),
        ("remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found", "repository-access-denied"),
        ("fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403", "repository-access-denied"),
        ("fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com", "repository-clone-failed"),
        ("fatal: early EOF", "repository-clone-failed"),
    ] {
        assert_eq!(clone_failure_category(stderr), category, "{stderr}");
    }
    // A full disk is the reason even when it also broke the transfer or the sign-in.
    assert_eq!(clone_failure_category("fatal: Authentication failed\nerror: No space left on device"), "workspace-disk-full");
}
