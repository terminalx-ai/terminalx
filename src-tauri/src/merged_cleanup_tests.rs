use super::*;
use crate::store::index::{Front, TabEntry, TabStatus};
use crate::store::projects::Project;
use crate::worktree_cleanup::Live;
use chrono::SubsecRound;
use std::sync::Arc;

/// The grace period every test runs with: ten minutes.
const GRACE: u64 = 600;

fn sh(cwd: &Path, args: &[&str]) -> String {
    git::run(cwd, args).unwrap_or_else(|e| panic!("git {args:?}: {e:#}")).trim().to_string()
}

fn commit(cwd: &Path, file: &str) {
    std::fs::write(cwd.join(file), file).unwrap();
    sh(cwd, &["add", "."]);
    sh(cwd, &["commit", "-q", "-m", file]);
}

#[derive(Default)]
struct Events(Mutex<Vec<(String, String)>>);

impl EventSink for Events {
    fn emit_raw(&self, event: &str, payload: Box<serde_json::value::RawValue>) {
        self.0.lock().unwrap().push((event.to_string(), payload.get().to_string()));
    }
    fn listen(&self, _: &str, _: crate::sink::Handler) -> crate::sink::ListenerId {
        crate::sink::ListenerId::Event(0)
    }
    fn unlisten(&self, _: crate::sink::ListenerId) {}
}

impl Events {
    fn named(&self, event: &str) -> Vec<String> {
        self.0.lock().unwrap().iter().filter(|(name, _)| name == event).map(|(_, payload)| payload.clone()).collect()
    }
}

struct Fixture {
    _home: crate::store::TempHome,
    _dir: tempfile::TempDir,
    base: PathBuf,
    projects: Vec<Project>,
    live: Mutex<Live>,
    events: Arc<Events>,
    /// What GitHub says of each branch, or that it cannot be asked.
    prs: Mutex<Result<HashMap<String, BranchPr>, String>>,
    /// Every question put to GitHub: the branches of one request.
    asked: Mutex<Vec<Vec<String>>>,
    /// The sessions the removal path stopped.
    stopped: Mutex<Vec<String>>,
    start: DateTime<Utc>,
}

impl Fixture {
    /// One project, `alpha`, with a bare remote its `main` is pushed to.
    fn new() -> Self {
        let home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let remote = base.join("alpha.git");
        std::fs::create_dir_all(&remote).unwrap();
        sh(&remote, &["init", "-q", "--bare", "-b", "main"]);
        let path = base.join("alpha");
        std::fs::create_dir_all(&path).unwrap();
        sh(&path, &["init", "-q", "-b", "main"]);
        sh(&path, &["config", "user.email", "t@example.com"]);
        sh(&path, &["config", "user.name", "T"]);
        std::fs::write(path.join(".gitignore"), "node_modules/\n.env\n").unwrap();
        commit(&path, "a.txt");
        sh(&path, &["remote", "add", "origin", remote.to_str().unwrap()]);
        sh(&path, &["push", "-q", "-u", "origin", "main"]);
        let mut fixture = Self {
            _home: home,
            _dir: dir,
            base,
            projects: Vec::new(),
            live: Mutex::new(Live::default()),
            events: Arc::new(Events::default()),
            prs: Mutex::new(Ok(HashMap::new())),
            asked: Mutex::new(Vec::new()),
            stopped: Mutex::new(Vec::new()),
            start: Utc::now().trunc_subsecs(0),
        };
        fixture.open(&path, "alpha");
        fixture
    }

    fn open(&mut self, path: &Path, name: &str) {
        self.projects.push(serde_json::from_value(serde_json::json!({ "path": path, "name": name })).unwrap());
    }

    fn alpha(&self) -> PathBuf {
        self.base.join("alpha")
    }

    fn branch(name: &str) -> String {
        git::worktree_branch(name)
    }

    /// A worktree TerminalX made, with a commit of its own pushed to its branch.
    fn worktree(&self, name: &str) -> PathBuf {
        let path = PathBuf::from(git::create_worktree(&self.alpha(), name, Some("main")).unwrap().path);
        commit(&path, &format!("{name}.txt"));
        sh(&path, &["push", "-q", "origin", "HEAD"]);
        std::fs::canonicalize(path).unwrap()
    }

    /// GitHub's answer for the worktree's branch: a pull request in `state`
    /// whose head is where the branch is now.
    fn pr(&self, name: &str, number: u64, state: &str) {
        let branch = Self::branch(name);
        let head = sh(&self.alpha(), &["rev-parse", &format!("refs/heads/{branch}")]);
        let pr = BranchPr { number, title: format!("Pull request for {name}"), url: format!("https://github.com/o/r/pull/{number}"), state: state.into(), head, base: "main".into() };
        self.prs.lock().unwrap().as_mut().unwrap().insert(branch, pr);
    }

    /// Merge the worktree's branch into `main` on the remote, as GitHub's
    /// "Create a merge commit" does, and say its pull request merged.
    fn merge(&self, name: &str, number: u64) {
        sh(&self.alpha(), &["merge", "-q", "--no-ff", "-m", &format!("Merge {name}"), &Self::branch(name)]);
        sh(&self.alpha(), &["push", "-q", "origin", "main"]);
        self.pr(name, number, "MERGED");
    }

    /// "Squash and merge": the branch's whole change as one new commit.
    fn squash(&self, name: &str, number: u64) {
        sh(&self.alpha(), &["merge", "-q", "--squash", &Self::branch(name)]);
        sh(&self.alpha(), &["commit", "-q", "-m", &format!("{name} (#{number})")]);
        sh(&self.alpha(), &["push", "-q", "origin", "main"]);
        self.pr(name, number, "MERGED");
    }

    /// "Rebase and merge": each commit made again on top of a `main` that
    /// has moved on, so none of the branch's own commits is in it.
    fn rebase(&self, name: &str, number: u64) {
        commit(&self.alpha(), &format!("moved-on-before-{name}.txt"));
        sh(&self.alpha(), &["cherry-pick", &format!("main..{}", Self::branch(name))]);
        sh(&self.alpha(), &["push", "-q", "origin", "main"]);
        self.pr(name, number, "MERGED");
    }

    fn session(&self, cwd: &Path, status: TabStatus) -> SessionEntry {
        let tab = TabEntry {
            id: uuid::Uuid::now_v7().to_string(),
            harness: "claude".into(),
            title: None,
            model: String::new(),
            effort: None, requested_model: None, requested_effort: None, requested_permission_mode: None,
            permission_mode: "default".into(),
            provider_session_id: None,
            status,
            created: index::now(),
            modified: index::now(),
            context_used: None,
            context_max: None,
            fork_from: None,
            follow: Default::default(),
            unknown: BTreeMap::new(),
        };
        let project = self.alpha();
        let session = SessionEntry {
            id: uuid::Uuid::now_v7().to_string(),
            kind: crate::store::index::SessionKind::Project,
            link: None,
            project_path: project.to_string_lossy().into_owned(),
            cwd: cwd.to_string_lossy().into_owned(),
            worktree_name: (cwd != project).then(|| cwd.file_name().unwrap().to_string_lossy().into_owned()),
            branch: None,
            base_ref: None,
            worktree_base: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: None,
            automation: None,
            title: format!("in {}", cwd.file_name().unwrap().to_string_lossy()),
            created: index::now(),
            modified: index::now(),
            archived: false,
            pinned: false,
            active_tab: None,
            tabs: vec![tab],
            unknown: BTreeMap::new(),
        };
        index::update(|sessions| {
            sessions.push(session.clone());
            Ok(())
        })
        .unwrap();
        std::fs::create_dir_all(crate::store::sessions_dir().unwrap().join(&session.id)).unwrap();
        session
    }

    /// `minutes` after the fixture was made. Every session in it was made
    /// in the first of those minutes.
    fn at(&self, minutes: i64) -> DateTime<Utc> {
        self.start + chrono::Duration::minutes(minutes)
    }

    fn with_host<R>(&self, f: impl FnOnce(&Host<'_>) -> R) -> R {
        let live = |_: &[SessionEntry]| self.live.lock().unwrap().clone();
        f(&Host { projects: &self.projects, protected: &[], confine: None, live: &live, fetch: Fetch::Fresh })
    }

    fn sweep_scope(&self, scope: &Scope, minutes: i64) -> Vec<Status> {
        self.pass(scope, minutes).statuses
    }

    /// One pass, with the projects GitHub could not be asked about.
    fn pass(&self, scope: &Scope, minutes: i64) -> Swept {
        // Stopping a session ends its agents and its shells.
        let stop = |session: &SessionEntry| {
            self.stopped.lock().unwrap().push(session.id.clone());
            let mut live = self.live.lock().unwrap();
            live.tabs.retain(|(id, _)| *id != session.id);
            live.panes.retain(|(pane, _)| !pane.starts_with(&format!("{}:", session.id)) && !session.tabs.iter().any(|tab| *pane == format!("tab:{}", tab.id)));
        };
        let pull_requests = |_: &Path, branches: &[String]| {
            self.asked.lock().unwrap().push(branches.to_vec());
            match &*self.prs.lock().unwrap() {
                Ok(prs) => Ok(prs.iter().filter(|(branch, _)| branches.contains(branch)).map(|(branch, pr)| (branch.clone(), pr.clone())).collect()),
                Err(error) => Err(anyhow::anyhow!(error.clone())),
            }
        };
        self.with_host(|host| sweep(&Sweep { host, sink: &*self.events, stop: &stop, pull_requests: &pull_requests, now: self.at(minutes) }, scope).unwrap())
    }

    fn on(&self) -> Scope {
        Scope { projects: vec![self.alpha().to_string_lossy().into_owned()], delete_sessions: false, grace_seconds: GRACE }
    }

    /// One pass with the setting on for `alpha`.
    fn sweep(&self, minutes: i64) -> Vec<Status> {
        self.sweep_scope(&self.on(), minutes)
    }

    fn local_branch(&self, name: &str) -> Option<String> {
        git::run(&self.alpha(), &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", Self::branch(name))]).ok().map(|sha| sha.trim().to_string())
    }

    fn remote_branch(&self, name: &str) -> Option<String> {
        remote_tip(&self.alpha(), &Self::branch(name)).unwrap()
    }
}

fn of<'a>(statuses: &'a [Status], path: &Path) -> &'a Status {
    statuses.iter().find(|status| Path::new(&status.path) == path).unwrap_or_else(|| panic!("no status for {}: {statuses:#?}", path.display()))
}

fn reason(status: &Status) -> (Phase, &str) {
    (status.phase, status.reason.as_deref().unwrap_or_default())
}

/// What a session's tab is now that it follows its terminal (#437).
fn fronted(session: &SessionEntry, front: Front) {
    index::update(|sessions| {
        sessions.iter_mut().find(|entry| entry.id == session.id).unwrap().tabs[0].follow.front = front;
        Ok(())
    })
    .unwrap();
}

#[test]
fn with_the_setting_off_nothing_is_looked_at_and_nothing_goes() {
    let f = Fixture::new();
    let wt = f.worktree("quiet-amber-fox");
    f.session(&wt, TabStatus::Idle);
    f.merge("quiet-amber-fox", 62);

    let off = Scope { projects: Vec::new(), delete_sessions: true, grace_seconds: 0 };
    assert_eq!(f.sweep_scope(&off, 1), vec![]);
    assert_eq!(f.sweep_scope(&off, 600), vec![]);
    assert!(f.asked.lock().unwrap().is_empty(), "GitHub is not asked for a project it is off for");
    assert!(wt.exists() && f.local_branch("quiet-amber-fox").is_some() && f.remote_branch("quiet-amber-fox").is_some());
    assert!(f.stopped.lock().unwrap().is_empty());
    assert!(!Ledger::file().unwrap().exists(), "nothing is written either");

    // What decides the scope on a desktop: the settings, per project.
    let settings = crate::store::settings::MergedCleanupSettings::default();
    assert!(f.projects.iter().all(|project| !settings.enabled_for(&project.path)));
}

#[test]
fn a_merged_clean_workspace_goes_after_the_grace_period_with_both_branches_and_its_conversation_stays() {
    let f = Fixture::new();
    let alpha = f.alpha();
    let wt = f.worktree("quiet-amber-fox");
    // Known build output is not a reason to keep it.
    std::fs::create_dir_all(wt.join("node_modules/pkg")).unwrap();
    std::fs::write(wt.join("node_modules/pkg/index.js"), "x").unwrap();
    let main_session = f.session(&alpha, TabStatus::Idle);
    let session = f.session(&wt, TabStatus::Idle);
    let head = f.local_branch("quiet-amber-fox").unwrap();
    f.merge("quiet-amber-fox", 62);

    // First seen: scheduled, said once as new, and nothing has gone.
    let first = f.sweep(1);
    assert_eq!(first.len(), 1, "{first:#?}");
    let status = of(&first, &wt);
    assert_eq!((status.phase, status.fresh, status.due.as_deref()), (Phase::Scheduled, true, Some(stamp(f.at(11)).as_str())));
    assert_eq!((status.name.as_str(), status.branch.as_str(), status.pr.number, status.pr.head.as_str()), ("quiet-amber-fox", "raccoon/quiet-amber-fox", 62, head.as_str()));
    assert_eq!(status.sessions, vec![session.id.clone()]);
    assert!(wt.exists());
    // Within the grace period: still scheduled for the same moment.
    let waiting = f.sweep(10);
    assert_eq!((of(&waiting, &wt).phase, of(&waiting, &wt).fresh, of(&waiting, &wt).due.clone()), (Phase::Scheduled, false, status.due.clone()));
    assert!(wt.exists() && f.stopped.lock().unwrap().is_empty());

    // The grace period has run.
    let done = f.sweep(12);
    let status = of(&done, &wt);
    assert_eq!(status.phase, Phase::Removed, "{status:#?}");
    let record = status.record.clone().unwrap();
    assert_eq!((record.path.as_str(), record.name.as_str(), record.branch.as_str(), record.commit.as_str()), (wt.to_str().unwrap(), "quiet-amber-fox", "raccoon/quiet-amber-fox", head.as_str()));
    assert_eq!((record.pr.number, record.pr.url.as_str(), record.pr.head.as_str()), (62, "https://github.com/o/r/pull/62", head.as_str()));
    assert_eq!((&record.local_branch, &record.remote_branch), (&BranchFate::Deleted, &BranchFate::Deleted));
    assert_eq!((record.sessions_kept.clone(), record.sessions_deleted.len()), (vec![session.id.clone()], 0));
    // The worktree, its local branch, its remote branch and the tracking ref are gone.
    assert!(!wt.exists());
    assert_eq!((f.local_branch("quiet-amber-fox"), f.remote_branch("quiet-amber-fox")), (None, None));
    assert!(git::run(&alpha, &["rev-parse", "--verify", "--quiet", "refs/remotes/origin/raccoon/quiet-amber-fox"]).is_err());
    // It went through the one removal path: the idle session was stopped, and told so.
    assert_eq!(*f.stopped.lock().unwrap(), vec![session.id.clone()]);
    assert!(f.events.named("session_updated").iter().any(|payload| payload.contains(&session.id)));
    assert!(!f.events.named(session_ops::WORKSPACES_CHANGED_EVENT).is_empty());
    // The conversation is kept, filed under the project as from a removed workspace.
    let kept = index::get(&session.id).unwrap();
    assert!(kept.worktree_removed && kept.removed_workspace.as_ref().is_some_and(|removed| removed.path == wt.to_string_lossy()));
    assert_eq!(cleanup::canonical(Path::new(&kept.cwd)), alpha);
    assert!(crate::store::sessions_dir().unwrap().join(&session.id).exists());
    // The main directory and its session are exactly as they were.
    assert_eq!(index::get(&main_session.id).unwrap(), main_session);
    assert!(alpha.join("a.txt").exists() && sh(&alpha, &["rev-parse", "--abbrev-ref", "HEAD"]) == "main");

    // It is recorded, and the next pass has nothing left to say.
    let recorded = f.with_host(|host| records(host).unwrap());
    assert_eq!(recorded.len(), 1);
    assert_eq!((&recorded[0].record, &recorded[0].blocked), (&record, &None));
    assert_eq!(f.sweep(13), vec![]);
    // One request per pass for the whole project.
    assert!(f.asked.lock().unwrap().iter().all(|branches| branches == &vec!["raccoon/quiet-amber-fox".to_string()]));
}

#[test]
fn squash_and_rebase_merges_are_recognised_and_their_branches_go_too() {
    let f = Fixture::new();
    let squashed = f.worktree("squashed-one");
    commit(&squashed, "second.txt");
    sh(&squashed, &["push", "-q", "origin", "HEAD"]);
    let rebased = f.worktree("rebased-one");
    commit(&rebased, "another.txt");
    sh(&rebased, &["push", "-q", "origin", "HEAD"]);
    f.squash("squashed-one", 70);
    f.rebase("rebased-one", 71);
    // Neither branch's own commits are in main.
    for name in ["squashed-one", "rebased-one"] {
        assert_ne!(sh(&f.alpha(), &["rev-list", "--count", &format!("origin/main..{}", Fixture::branch(name))]), "0");
    }

    assert!(f.sweep(1).iter().all(|status| status.phase == Phase::Scheduled));
    let done = f.sweep(12);
    for (path, name) in [(&squashed, "squashed-one"), (&rebased, "rebased-one")] {
        let record = of(&done, path).record.clone().unwrap_or_else(|| panic!("{name}: {done:#?}"));
        assert_eq!((&record.local_branch, &record.remote_branch), (&BranchFate::Deleted, &BranchFate::Deleted), "{name}");
        assert!(!path.exists());
        assert_eq!((f.local_branch(name), f.remote_branch(name)), (None, None), "{name}");
    }
}

#[test]
fn a_workspace_that_fails_any_check_stays_and_says_why() {
    let f = Fixture::new();
    let alpha = f.alpha();
    let names = ["uncommitted", "unpushed", "unmerged", "ignored", "running", "waiting", "terminal", "operation", "stash", "locked", "hidden", "held"];
    let paths: HashMap<&str, PathBuf> = names.iter().map(|name| (*name, f.worktree(name))).collect();
    let at = |name: &str| paths[name].clone();
    for (number, name) in names.iter().enumerate() {
        f.merge(name, 100 + number as u64);
    }

    // Two files that are not committed.
    std::fs::write(at("uncommitted").join("uncommitted.txt"), "edited").unwrap();
    std::fs::write(at("uncommitted").join("new.txt"), "new").unwrap();
    // A commit made after the merge, only on this machine.
    commit(&at("unpushed"), "after-the-merge.txt");
    // A commit made after the merge and pushed: on the remote, in no pull request.
    commit(&at("unmerged"), "after-the-merge.txt");
    sh(&at("unmerged"), &["push", "-q", "origin", "HEAD"]);
    // An ignored file that is not build output.
    std::fs::write(at("ignored").join(".env"), "SECRET=1").unwrap();
    // A turn that is running, one that waits for an answer, and a terminal the reader opened.
    f.session(&at("running"), TabStatus::InProgress);
    f.session(&at("waiting"), TabStatus::Waiting);
    let with_terminal = f.session(&at("terminal"), TabStatus::Idle);
    f.live.lock().unwrap().panes.push((format!("{}:shell-1", with_terminal.id), at("terminal")));
    // A merge that was started and not finished.
    let git_dir = sh(&at("operation"), &["rev-parse", "--absolute-git-dir"]);
    std::fs::write(Path::new(&git_dir).join("MERGE_HEAD"), sh(&alpha, &["rev-parse", "HEAD"])).unwrap();
    // Work that was stashed on the branch.
    std::fs::write(at("stash").join("stash.txt"), "put away").unwrap();
    sh(&at("stash"), &["stash", "-q"]);
    // Locked by hand, and a file git was told not to look at.
    sh(&alpha, &["worktree", "lock", at("locked").to_str().unwrap()]);
    sh(&at("hidden"), &["update-index", "--assume-unchanged", "hidden.txt"]);
    // The reader said to keep this one.
    f.session(&at("held"), TabStatus::Idle);

    let expected: Vec<(&str, Phase, &str)> = vec![
        ("uncommitted", Phase::Kept, "2 uncommitted files"),
        ("unpushed", Phase::Kept, "1 unpushed commit"),
        ("unmerged", Phase::Kept, "1 commit is not in origin/main"),
        ("ignored", Phase::Kept, "ignored local files: .env"),
        ("running", Phase::Kept, "an agent is running in \"in running\""),
        ("waiting", Phase::Kept, "waiting for an answer in \"in waiting\""),
        ("terminal", Phase::Kept, "a terminal is open in \"in terminal\""),
        ("operation", Phase::Kept, "a merge is in progress"),
        ("stash", Phase::Kept, "1 stash entry on its branch"),
        ("locked", Phase::Kept, "it is protected"),
        ("hidden", Phase::Kept, "it could not be checked"),
    ];
    let first = f.sweep(1);
    assert_eq!(first.len(), names.len(), "{first:#?}");
    for (name, phase, why) in &expected {
        let status = of(&first, &at(name));
        assert_eq!(reason(status), (*phase, *why), "{name}: {status:#?}");
        assert!(status.detail.as_deref().is_some_and(|detail| !detail.is_empty()), "{name} says more when asked");
    }
    assert_eq!(of(&first, &at("held")).phase, Phase::Scheduled);
    hold(at("held").to_str().unwrap(), true, f.at(2)).unwrap();

    // Long after the grace period every one of them is still there, for the
    // same reason, with its branch here and on the remote.
    let later = f.sweep(120);
    for (name, phase, why) in &expected {
        assert_eq!(reason(of(&later, &at(name))), (*phase, *why), "{name}");
    }
    assert_eq!(reason(of(&later, &at("held"))), (Phase::Held, ""));
    for name in names {
        assert!(at(name).exists(), "{name} was removed");
        assert!(f.local_branch(name).is_some() && f.remote_branch(name).is_some(), "{name} lost a branch");
    }
    // Nothing was stopped to get there, and nothing was recorded as removed.
    assert!(f.stopped.lock().unwrap().is_empty());
    assert!(f.with_host(|host| records(host).unwrap()).is_empty());

    // Let go of again, it waits out a grace period of its own.
    hold(at("held").to_str().unwrap(), false, f.at(121)).unwrap();
    let again = f.sweep(122);
    assert_eq!((of(&again, &at("held")).phase, of(&again, &at("held")).due.clone()), (Phase::Scheduled, Some(stamp(f.at(131)))));
    assert!(hold("/not/a/workspace", true, f.at(122)).is_err());
}

#[test]
fn an_agent_sitting_idle_is_stopped_and_does_not_keep_it_but_something_else_running_there_does() {
    let f = Fixture::new();
    let idle = f.worktree("idle-agent");
    let busy = f.worktree("left-running");
    f.merge("idle-agent", 80);
    f.merge("left-running", 81);
    // An agent's CLI at its prompt: a live process in its own terminal.
    let idle_session = f.session(&idle, TabStatus::Idle);
    let busy_session = f.session(&busy, TabStatus::Idle);
    {
        let mut live = f.live.lock().unwrap();
        for (session, path) in [(&idle_session, &idle), (&busy_session, &busy)] {
            live.tabs.insert((session.id.clone(), session.tabs[0].id.clone()));
            live.panes.push((format!("tab:{}", session.tabs[0].id), path.clone()));
        }
        // Something that is not the session's is running in the second one.
        live.process_dirs.push(busy.join("src"));
    }

    let first = f.sweep(1);
    assert!(first.iter().all(|status| status.phase == Phase::Scheduled), "{first:#?}");
    assert!(f.stopped.lock().unwrap().is_empty(), "nothing is stopped before a removal is due");

    let done = f.sweep(12);
    assert_eq!(of(&done, &idle).phase, Phase::Removed);
    assert!(!idle.exists());
    // Its own agent was stopped, but what is left is not ours to end.
    assert_eq!(reason(of(&done, &busy)), (Phase::Kept, "1 process is running in it"));
    assert!(busy.exists() && f.local_branch("left-running").is_some() && f.remote_branch("left-running").is_some());
    let mut stopped = f.stopped.lock().unwrap().clone();
    stopped.sort();
    let mut both = vec![idle_session.id.clone(), busy_session.id.clone()];
    both.sort();
    assert_eq!(stopped, both);
    assert!(!index::get(&busy_session.id).unwrap().worktree_removed);
}

#[test]
fn a_tab_that_is_a_shell_now_or_holds_an_agent_started_by_hand_keeps_it_like_any_terminal() {
    let f = Fixture::new();
    let names = ["shell-now", "by-hand", "shell-gone"];
    let paths: Vec<PathBuf> = names.iter().map(|name| f.worktree(name)).collect();
    for (number, name) in names.iter().enumerate() {
        f.merge(name, 90 + number as u64);
    }
    // The agent was exited and its shell is still there; an agent the reader
    // typed into that shell; and a tab that was left a shell, which has ended.
    let sessions: Vec<SessionEntry> = paths.iter().map(|path| f.session(path, TabStatus::Idle)).collect();
    fronted(&sessions[0], Front::Terminal);
    fronted(&sessions[1], Front::ByHand);
    fronted(&sessions[2], Front::Terminal);
    {
        let mut live = f.live.lock().unwrap();
        for (session, path) in sessions.iter().zip(&paths).take(2) {
            live.tabs.insert((session.id.clone(), session.tabs[0].id.clone()));
            live.panes.push((format!("tab:{}", session.tabs[0].id), path.clone()));
        }
    }

    f.sweep(1);
    let due = f.sweep(12);
    assert_eq!(reason(of(&due, &paths[0])), (Phase::Kept, "a terminal is open in \"in shell-now\""));
    assert_eq!(reason(of(&due, &paths[1])), (Phase::Kept, "an agent started by hand is open in \"in by-hand\""));
    assert_eq!(of(&due, &paths[2]).phase, Phase::Removed);
    // Nothing the reader started was stopped to find that out.
    assert_eq!(*f.stopped.lock().unwrap(), vec![sessions[2].id.clone()]);
    assert!(paths[0].exists() && paths[1].exists() && !paths[2].exists());
}

#[test]
fn only_a_merged_pull_request_counts_and_only_for_a_worktree_terminalx_made() {
    let mut f = Fixture::new();
    let alpha = f.alpha();
    let open = f.worktree("still-open");
    let closed = f.worktree("closed-unmerged");
    let none = f.worktree("no-pull-request");
    let detached = f.worktree("detached-head");
    let reopened = f.worktree("merged-then-reopened");
    f.pr("still-open", 1, "OPEN");
    f.pr("closed-unmerged", 2, "CLOSED");
    f.merge("detached-head", 3);
    sh(&detached, &["checkout", "-q", "--detach"]);
    f.merge("merged-then-reopened", 4);
    // A worktree made by hand, outside the project's worktree folder.
    let by_hand = f.base.join("by-hand");
    sh(&alpha, &["worktree", "add", "-q", "-b", "by-hand", by_hand.to_str().unwrap(), "main"]);
    commit(&by_hand, "by-hand.txt");
    sh(&by_hand, &["push", "-q", "origin", "HEAD"]);
    sh(&alpha, &["merge", "-q", "--no-ff", "-m", "Merge by-hand", "by-hand"]);
    sh(&alpha, &["push", "-q", "origin", "main"]);
    let head = sh(&alpha, &["rev-parse", "by-hand"]);
    // GitHub would even say the default branch has a merged pull request.
    let mut answers = f.prs.lock().unwrap().clone().unwrap();
    for (branch, head) in [("by-hand", head), ("main", sh(&alpha, &["rev-parse", "main"]))] {
        answers.insert(branch.into(), BranchPr { number: 9, title: "T".into(), url: "u".into(), state: "MERGED".into(), head, base: "main".into() });
    }
    *f.prs.lock().unwrap() = Ok(answers);
    f.session(&alpha, TabStatus::Idle);

    let first = f.sweep(1);
    assert_eq!(first.len(), 1, "{first:#?}");
    assert_eq!(of(&first, &reopened).phase, Phase::Scheduled);
    // The main directory's branch and a hand-made worktree's are never asked about.
    let asked = f.asked.lock().unwrap().concat();
    assert!(!asked.contains(&"main".to_string()) && !asked.contains(&"by-hand".to_string()), "{asked:?}");

    // A new pull request was opened on the branch that had merged: it is no
    // longer finished, and what was seen of it is forgotten.
    f.pr("merged-then-reopened", 5, "OPEN");
    assert_eq!(f.sweep(5), vec![]);
    assert_eq!(f.sweep(60), vec![]);
    for path in [&open, &closed, &none, &detached, &reopened, &by_hand, &alpha] {
        assert!(path.exists(), "{} was removed", path.display());
    }
    assert!(f.stopped.lock().unwrap().is_empty());
    // When that one merges too, the grace period starts from then.
    f.pr("merged-then-reopened", 5, "MERGED");
    let again = f.sweep(61);
    assert_eq!((of(&again, &reopened).phase, of(&again, &reopened).fresh, of(&again, &reopened).due.clone()), (Phase::Scheduled, true, Some(stamp(f.at(71)))));

    // A worktree that is itself open as a project is protected, whatever merged.
    f.open(&reopened, "nested");
    assert_eq!(reason(of(&f.sweep(80), &reopened)), (Phase::Kept, "it is protected"));
    assert!(reopened.exists());
}

#[test]
fn a_remote_branch_that_moved_after_the_merge_is_kept_and_said_so() {
    let f = Fixture::new();
    let wt = f.worktree("moved-on-remote");
    f.merge("moved-on-remote", 90);
    let merged = f.local_branch("moved-on-remote").unwrap();
    // Someone else pushed to the branch after it merged.
    let other = f.base.join("other");
    sh(&f.base, &["clone", "-q", "alpha.git", "other"]);
    sh(&other, &["config", "user.email", "o@example.com"]);
    sh(&other, &["config", "user.name", "O"]);
    sh(&other, &["checkout", "-q", "raccoon/moved-on-remote"]);
    commit(&other, "pushed-after-the-merge.txt");
    sh(&other, &["push", "-q", "origin", "HEAD"]);
    let moved_to = sh(&other, &["rev-parse", "HEAD"]);

    f.sweep(1);
    let done = f.sweep(12);
    let record = of(&done, &wt).record.clone().unwrap();
    // Everything here was merged, so the workspace and its local branch go.
    assert!(!wt.exists());
    assert_eq!((&record.local_branch, f.local_branch("moved-on-remote")), (&BranchFate::Deleted, None));
    // The remote branch holds a commit that was not merged: it stays, where it is.
    assert_eq!(record.remote_branch, BranchFate::Moved { at: moved_to.clone() });
    assert_eq!(f.remote_branch("moved-on-remote"), Some(moved_to.clone()));

    // The remote itself refuses a deletion that expects another commit.
    assert_eq!(delete_remote_branch(&f.alpha(), "raccoon/moved-on-remote", &merged), BranchFate::Moved { at: moved_to.clone() });
    let lease = format!("--force-with-lease=refs/heads/raccoon/moved-on-remote:{merged}");
    assert!(git::run(&f.alpha(), &["push", "--quiet", &lease, "origin", ":refs/heads/raccoon/moved-on-remote"]).is_err());
    assert_eq!(f.remote_branch("moved-on-remote"), Some(moved_to));
}

#[test]
fn a_remote_branch_github_already_deleted_is_no_obstacle() {
    let f = Fixture::new();
    let wt = f.worktree("deleted-by-github");
    f.squash("deleted-by-github", 91);
    // GitHub deleted the head branch on merge, and a fetch pruned its trace:
    // the branch's own commits are now on no remote at all.
    sh(&f.alpha(), &["push", "-q", "origin", ":refs/heads/raccoon/deleted-by-github"]);
    sh(&f.alpha(), &["fetch", "-q", "--prune", "origin"]);
    assert_ne!(sh(&wt, &["rev-list", "--count", "HEAD", "--not", "--remotes"]), "0");

    f.sweep(1);
    let done = f.sweep(12);
    let record = of(&done, &wt).record.clone().unwrap_or_else(|| panic!("{done:#?}"));
    assert_eq!((&record.local_branch, &record.remote_branch), (&BranchFate::Deleted, &BranchFate::AlreadyGone));
    assert!(!wt.exists() && f.local_branch("deleted-by-github").is_none());
}

#[test]
fn a_remote_that_refuses_the_deletion_keeps_its_branch_and_the_local_removal_stands() {
    let f = Fixture::new();
    let wt = f.worktree("remote-refuses");
    f.merge("remote-refuses", 92);
    // Reading the remote works; writing to it does not.
    sh(&f.alpha(), &["config", "remote.origin.pushurl", f.base.join("nowhere.git").to_str().unwrap()]);

    f.sweep(1);
    let done = f.sweep(12);
    let record = of(&done, &wt).record.clone().unwrap();
    assert!(!wt.exists());
    assert_eq!(record.local_branch, BranchFate::Deleted);
    assert!(matches!(&record.remote_branch, BranchFate::Kept { reason } if reason.starts_with("it could not be deleted")), "{:?}", record.remote_branch);
    assert!(f.remote_branch("remote-refuses").is_some());
}

#[test]
fn work_in_its_sessions_restarts_the_grace_period() {
    let f = Fixture::new();
    let wt = f.worktree("still-in-use");
    let session = f.session(&wt, TabStatus::Idle);
    f.merge("still-in-use", 93);
    assert_eq!(of(&f.sweep(1), &wt).due, Some(stamp(f.at(11))));
    // A turn ended eight minutes in.
    index::update(|sessions| {
        sessions.iter_mut().find(|entry| entry.id == session.id).unwrap().modified = stamp(f.at(8));
        Ok(())
    })
    .unwrap();
    let waiting = f.sweep(12);
    assert_eq!((of(&waiting, &wt).phase, of(&waiting, &wt).due.clone()), (Phase::Scheduled, Some(stamp(f.at(18)))));
    assert!(wt.exists());
    assert_eq!(of(&f.sweep(19), &wt).phase, Phase::Removed);
}

#[test]
fn conversations_are_deleted_only_when_that_is_switched_on() {
    let f = Fixture::new();
    let wt = f.worktree("with-conversation");
    let session = f.session(&wt, TabStatus::Idle);
    f.merge("with-conversation", 94);
    let scope = Scope { delete_sessions: true, ..f.on() };
    f.sweep_scope(&scope, 1);
    let done = f.sweep_scope(&scope, 12);
    let record = of(&done, &wt).record.clone().unwrap();
    assert_eq!((record.sessions_kept.len(), record.sessions_deleted.clone()), (0, vec![session.id.clone()]));
    assert!(index::get(&session.id).is_err());
    assert!(!crate::store::sessions_dir().unwrap().join(&session.id).exists());
    assert!(f.events.named(session_ops::SESSION_DELETED_EVENT).iter().any(|payload| payload.contains(&session.id)));
}

#[test]
fn an_undo_puts_back_the_worktree_its_branches_and_its_sessions_and_keeps_it_from_then_on() {
    let f = Fixture::new();
    let wt = f.worktree("undone");
    let untouched = f.session(&wt, TabStatus::Idle);
    let used = f.session(&wt, TabStatus::Idle);
    f.squash("undone", 95);
    let head = f.local_branch("undone").unwrap();
    f.sweep(1);
    let record = of(&f.sweep(12), &wt).record.clone().unwrap();
    assert!(!wt.exists() && f.local_branch("undone").is_none() && f.remote_branch("undone").is_none());
    // One of its conversations was continued from the project afterwards.
    index::update(|sessions| {
        sessions.iter_mut().find(|entry| entry.id == used.id).unwrap().modified = stamp(f.at(20));
        Ok(())
    })
    .unwrap();

    assert!(f.with_host(|host| restore(host, &*f.events, "no-such-removal", f.at(21))).is_err());
    let restored = f.with_host(|host| restore(host, &*f.events, &record.id, f.at(21)).unwrap());
    assert_eq!(restored.record.restored_at, Some(stamp(f.at(21))));
    // The worktree is back where it was, on its branch, at the commit it was at.
    assert!(wt.join("undone.txt").exists());
    assert_eq!((sh(&wt, &["rev-parse", "HEAD"]), sh(&wt, &["rev-parse", "--abbrev-ref", "HEAD"])), (head.clone(), "raccoon/undone".to_string()));
    assert_eq!((f.local_branch("undone"), f.remote_branch("undone")), (Some(head.clone()), Some(head)));
    // The session nobody touched is in it again; the one used since stays put, and that is said.
    let back = index::get(&untouched.id).unwrap();
    assert!(!back.worktree_removed && back.removed_workspace.is_none());
    assert_eq!((back.cwd.as_str(), back.worktree_name.as_deref(), back.branch.as_deref()), (wt.to_str().unwrap(), Some("undone"), Some("raccoon/undone")));
    assert!(index::get(&used.id).unwrap().worktree_removed);
    assert_eq!(restored.notes, vec![format!("The session \"{}\" has been used since and stays under the project.", used.title)]);

    // It is not undone twice, and it is not taken again: its pull request is
    // still merged, but it is the reader's to keep now.
    let recorded = f.with_host(|host| records(host).unwrap());
    assert_eq!(recorded[0].blocked.as_deref(), Some("It was brought back already."));
    assert!(f.with_host(|host| restore(host, &*f.events, &record.id, f.at(22))).is_err());
    assert_eq!(reason(of(&f.sweep(600), &wt)), (Phase::Held, ""));
    assert!(wt.exists());
}

#[test]
fn an_undo_is_refused_when_what_it_would_put_back_is_in_the_way() {
    let f = Fixture::new();
    let wt = f.worktree("in-the-way");
    let gone = f.worktree("branch-reused");
    f.merge("in-the-way", 96);
    f.merge("branch-reused", 97);
    f.sweep(1);
    let done = f.sweep(12);
    let (first, second) = (of(&done, &wt).record.clone().unwrap(), of(&done, &gone).record.clone().unwrap());

    // Something is at the path again.
    std::fs::create_dir_all(&wt).unwrap();
    // The branch name is in use again, for other work.
    sh(&f.alpha(), &["branch", "-q", "raccoon/branch-reused", "main"]);
    let recorded = f.with_host(|host| records(host).unwrap());
    let blocked = |id: &str| recorded.iter().find(|view| view.record.id == id).unwrap().blocked.clone().unwrap();
    assert_eq!(blocked(&first.id), "Something is at its path again.");
    assert_eq!(blocked(&second.id), "The branch raccoon/branch-reused exists again, at another commit.");
    for id in [&first.id, &second.id] {
        assert!(f.with_host(|host| restore(host, &*f.events, id, f.at(13))).is_err());
    }
    assert!(!gone.exists());

    // A record that names a path outside the project's worktree folder puts nothing there.
    let mut ledger = Ledger::load().unwrap();
    ledger.removed[0].path = f.base.join("elsewhere").to_string_lossy().into_owned();
    ledger.save().unwrap();
    std::fs::remove_dir(&wt).unwrap();
    let recorded = f.with_host(|host| records(host).unwrap());
    assert!(recorded.iter().any(|view| view.blocked.as_deref() == Some("Its path is not in the project's worktree folder.")), "{recorded:#?}");
    assert!(!f.base.join("elsewhere").exists());
}

#[test]
fn when_github_cannot_be_asked_nothing_is_forgotten_and_nothing_goes() {
    let f = Fixture::new();
    let wt = f.worktree("offline");
    f.merge("offline", 98);
    assert_eq!(of(&f.sweep(1), &wt).phase, Phase::Scheduled);
    let known = std::mem::replace(&mut *f.prs.lock().unwrap(), Err("gh: could not reach github.com".into()));

    let offline = f.pass(&f.on(), 8);
    assert_eq!(reason(of(&offline.statuses, &wt)), (Phase::Kept, "GitHub could not be asked"));
    // The project is named with the reason, for the setting to show.
    assert_eq!(offline.unreadable, vec![Unreadable { project_path: f.alpha().to_string_lossy().into_owned(), reason: "gh: could not reach github.com".into() }]);
    assert!(wt.exists());
    // Asked again later, it goes: when the merge was first seen was not lost.
    *f.prs.lock().unwrap() = known;
    let back = f.pass(&f.on(), 12);
    assert_eq!((of(&back.statuses, &wt).phase, back.unreadable.len()), (Phase::Removed, 0));
}

#[test]
fn the_grace_period_runs_only_while_passes_do() {
    let f = Fixture::new();
    let wt = f.worktree("app-was-closed");
    let held = f.worktree("held-meanwhile");
    f.merge("app-was-closed", 110);
    f.merge("held-meanwhile", 111);
    let first = f.sweep(1);
    assert_eq!((of(&first, &wt).fresh, of(&first, &wt).due.clone()), (true, Some(stamp(f.at(11)))));
    hold(held.to_str().unwrap(), true, f.at(2)).unwrap();

    // The app was closed two minutes later and opened the next morning: the
    // workspace is not gone the moment it starts. It is said again, and
    // waits out a grace period from now.
    let morning = f.sweep(900);
    let status = of(&morning, &wt);
    assert_eq!((status.phase, status.fresh, status.due.clone()), (Phase::Scheduled, true, Some(stamp(f.at(910)))));
    assert!(wt.exists() && f.stopped.lock().unwrap().is_empty());
    // What the reader chose to keep is still kept.
    assert_eq!(of(&morning, &held).phase, Phase::Held);
    // Watched from then on, it goes when that grace period has run.
    assert_eq!(of(&f.sweep(905), &wt).phase, Phase::Scheduled);
    assert_eq!(of(&f.sweep(911), &wt).phase, Phase::Removed);
    assert!(held.exists());
}

#[test]
fn turning_it_off_and_on_again_starts_the_grace_period_again() {
    let f = Fixture::new();
    let wt = f.worktree("off-and-on");
    f.merge("off-and-on", 99);
    assert_eq!(of(&f.sweep(1), &wt).due, Some(stamp(f.at(11))));
    // Off: nothing is said, and what was seen is forgotten.
    assert_eq!(f.sweep_scope(&Scope { projects: Vec::new(), ..f.on() }, 5), vec![]);
    // On again an hour later: not removed on the spot.
    let again = f.sweep(60);
    assert_eq!((of(&again, &wt).phase, of(&again, &wt).fresh, of(&again, &wt).due.clone()), (Phase::Scheduled, true, Some(stamp(f.at(70)))));
    assert!(wt.exists());
}
