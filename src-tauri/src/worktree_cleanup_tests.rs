use super::*;
use crate::store::index::TabEntry;
use std::collections::BTreeMap;

fn sh(cwd: &Path, args: &[&str]) {
    git::run(cwd, args).unwrap_or_else(|e| panic!("git {args:?}: {e:#}"));
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
}

impl Fixture {
    fn new() -> Self {
        let home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let mut fixture = Self { _home: home, _dir: dir, base, projects: Vec::new(), live: Mutex::new(Live::default()), events: Arc::new(Events::default()) };
        fixture.project("alpha");
        fixture
    }

    /// A project with a bare remote its `main` is pushed to.
    fn project(&mut self, name: &str) -> PathBuf {
        let remote = self.base.join(format!("{name}.git"));
        std::fs::create_dir_all(&remote).unwrap();
        sh(&remote, &["init", "-q", "--bare", "-b", "main"]);
        let path = self.base.join(name);
        std::fs::create_dir_all(&path).unwrap();
        sh(&path, &["init", "-q", "-b", "main"]);
        sh(&path, &["config", "user.email", "t@example.com"]);
        sh(&path, &["config", "user.name", "T"]);
        std::fs::write(path.join(".gitignore"), "node_modules/\n.env\nlocal.db\n").unwrap();
        commit(&path, "a.txt");
        sh(&path, &["remote", "add", "origin", remote.to_str().unwrap()]);
        sh(&path, &["push", "-q", "-u", "origin", "main"]);
        self.open(&path, name);
        path
    }

    fn open(&mut self, path: &Path, name: &str) {
        self.projects.push(serde_json::from_value(serde_json::json!({ "path": path, "name": name })).unwrap());
    }

    fn alpha(&self) -> PathBuf {
        self.base.join("alpha")
    }

    fn worktree(&self, project: &Path, name: &str) -> PathBuf {
        PathBuf::from(git::create_worktree(project, name, Some("main")).unwrap().path)
    }

    /// A worktree with a commit of its own, pushed to its branch on the remote.
    fn pushed(&self, project: &Path, name: &str) -> PathBuf {
        let path = self.worktree(project, name);
        commit(&path, &format!("{name}.txt"));
        sh(&path, &["push", "-q", "origin", "HEAD"]);
        path
    }

    fn session(&self, project: &Path, cwd: &Path, status: TabStatus) -> SessionEntry {
        let tab = TabEntry {
            id: uuid::Uuid::now_v7().to_string(),
            harness: "claude".into(),
            title: None,
            model: String::new(),
            effort: None, requested_model: None, requested_effort: None,
            permission_mode: "default".into(),
            provider_session_id: None,
            status,
            created: index::now(),
            modified: index::now(),
            context_used: None,
            context_max: None,
            fork_from: None,
            unknown: BTreeMap::new(),
        };
        let session = SessionEntry {
            id: uuid::Uuid::now_v7().to_string(),
            kind: crate::store::index::SessionKind::Project,
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

    fn with_host<R>(&self, protected: &[PathBuf], confine: Option<&Path>, f: impl FnOnce(&Host<'_>) -> R) -> R {
        let live = |_: &[SessionEntry]| self.live.lock().unwrap().clone();
        f(&Host { projects: &self.projects, protected, confine, live: &live, fetch: Fetch::Fresh })
    }

    fn scan(&self) -> Vec<ProjectScan> {
        self.with_host(&[], None, |host| scan(host, None).unwrap())
    }

    fn find(&self, path: &Path) -> Candidate {
        let path = canonical(path);
        self.scan().into_iter().flat_map(|project| project.candidates).find(|candidate| Path::new(&candidate.path) == path).unwrap_or_else(|| panic!("{} is not listed", path.display()))
    }

    fn item(&self, candidate: &Candidate) -> RemoveItem {
        RemoveItem { project_path: candidate.project_path.clone(), path: candidate.path.clone(), token: candidate.token.clone(), delete_sessions: false, accept_ignored: false }
    }

    fn remove(&self, items: &[RemoveItem]) -> Vec<ItemResult> {
        self.with_host(&[], None, |host| remove(host, &*self.events, items))
    }

    fn remove_one(&self, item: RemoveItem) -> ItemResult {
        self.remove(&[item]).pop().unwrap()
    }
}

#[test]
fn a_clean_pushed_worktree_is_eligible_and_its_branch_and_conversations_stay() {
    let f = Fixture::new();
    let alpha = f.alpha();
    let wt = f.pushed(&alpha, "quiet-amber-fox");
    std::fs::create_dir_all(wt.join("node_modules/pkg")).unwrap();
    std::fs::write(wt.join("node_modules/pkg/index.js"), "x".repeat(8192)).unwrap();
    let main_session = f.session(&alpha, &alpha, TabStatus::Idle);
    let session = f.session(&alpha, &wt, TabStatus::Idle);

    let candidate = f.find(&wt);
    assert_eq!((candidate.verdict, candidate.reason.clone()), (Verdict::Eligible, None));
    assert_eq!(candidate.disposable, vec!["node_modules/"]);
    assert_eq!(candidate.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec![session.id.as_str()]);
    assert!(candidate.managed && candidate.last_activity.is_some());
    // Scanning removes nothing.
    assert!(wt.exists());

    let done = f.remove_one(f.item(&candidate));
    assert_eq!((done.outcome, done.reason.clone()), (Outcome::Removed, None));
    assert!(!wt.exists() && done.freed_bytes >= 8192);
    assert_eq!(done.sessions_kept, vec![session.id.clone()]);
    assert!(done.sessions_deleted.is_empty());
    // The branch outlives its checkout.
    let branch = candidate.branch.unwrap();
    assert_eq!(done.kept_branch.as_deref(), Some(branch.as_str()));
    sh(&alpha, &["rev-parse", "--verify", &format!("refs/heads/{branch}")]);
    // The conversation is kept, filed under the project as from a removed workspace.
    let kept = index::get(&session.id).unwrap();
    assert!(kept.worktree_removed && kept.removed_workspace.is_some());
    assert_eq!(canonical(Path::new(&kept.cwd)), alpha);
    assert!(crate::store::sessions_dir().unwrap().join(&session.id).exists());
    // The project's own session is exactly as it was.
    assert_eq!(index::get(&main_session.id).unwrap(), main_session);
    assert!(alpha.join("a.txt").exists());
    // Navigation hears about it; git no longer lists it.
    assert_eq!(f.events.named("workspaces_changed").len(), 1);
    assert!(!git::list_worktrees(&alpha).unwrap().iter().any(|(path, _)| Path::new(path) == wt));
}

#[test]
fn the_main_directory_is_protected_whatever_it_is_called_or_asked() {
    let mut f = Fixture::new();
    let alpha = f.alpha();
    // Not on `main`, clean, no sessions: still the project's own checkout.
    sh(&alpha, &["checkout", "-q", "-b", "feature/x"]);
    let main = f.find(&alpha);
    assert_eq!(main.verdict, Verdict::Protected);

    // A linked worktree that is open as a project of its own.
    let opened = f.pushed(&alpha, "opened-as-project");
    f.open(&opened, "opened");
    assert_eq!(f.find(&opened).verdict, Verdict::Protected);

    // A worktree that holds another open project inside it.
    let outer = f.pushed(&alpha, "outer");
    let nested = outer.join("node_modules/nested");
    std::fs::create_dir_all(&nested).unwrap();
    f.open(&nested, "nested");
    let found = f.find(&outer);
    assert_eq!(found.verdict, Verdict::Protected);
    assert!(found.reason.as_deref().unwrap().contains("contains"), "{:?}", found.reason);

    // The backend refuses each, with the token it handed out itself, by a
    // made-up token, and through a symlink to the main directory.
    let alias = f.base.join("alias");
    std::os::unix::fs::symlink(&alpha, &alias).unwrap();
    let session = f.session(&alpha, &alpha, TabStatus::Idle);
    for (path, token) in [(alpha.clone(), main.token.clone()), (alpha.clone(), "forged".into()), (alias, main.token), (opened.clone(), f.find(&opened).token), (outer.clone(), found.token)] {
        for project_path in [alpha.clone(), opened.clone()] {
            let item = RemoveItem { project_path: project_path.to_string_lossy().into_owned(), path: path.to_string_lossy().into_owned(), token: token.clone(), delete_sessions: true, accept_ignored: true };
            let done = f.remove_one(item);
            assert_eq!(done.outcome, Outcome::Skipped, "{}: {:?}", path.display(), done.reason);
        }
    }
    assert!(alpha.join("a.txt").exists() && opened.exists() && nested.exists());
    assert_eq!(index::get(&session.id).unwrap(), session);
    assert!(f.events.named("session_deleted").is_empty() && f.events.named("session_updated").is_empty());
}

#[test]
fn a_main_directory_reached_by_another_spelling_is_still_protected() {
    let mut f = Fixture::new();
    let alpha = f.alpha();
    let wt = f.pushed(&alpha, "aliased");
    // The same worktree is open as a project through a symlink.
    let link = f.base.join("link-to-worktree");
    std::os::unix::fs::symlink(&wt, &link).unwrap();
    f.open(&link, "linked");
    assert_eq!(f.find(&wt).verdict, Verdict::Protected);
}

#[test]
fn unsaved_work_keeps_a_worktree_out_of_the_clean_up() {
    let f = Fixture::new();
    let alpha = f.alpha();

    let modified = f.pushed(&alpha, "modified");
    std::fs::write(modified.join("a.txt"), "changed").unwrap();
    let staged = f.pushed(&alpha, "staged");
    std::fs::write(staged.join("new.txt"), "new").unwrap();
    sh(&staged, &["add", "new.txt"]);
    let untracked = f.pushed(&alpha, "untracked");
    std::fs::write(untracked.join("notes.md"), "mine").unwrap();
    for (path, word) in [(&modified, "modified"), (&staged, "staged"), (&untracked, "untracked")] {
        let found = f.find(path);
        assert_eq!(found.verdict, Verdict::Dirty, "{word}");
        assert!(found.reason.as_deref().unwrap().contains(word), "{:?}", found.reason);
    }

    // Clean, but its commit is nowhere else.
    let unpushed = f.worktree(&alpha, "unpushed");
    commit(&unpushed, "only-here.txt");
    let found = f.find(&unpushed);
    assert_eq!(found.verdict, Verdict::Unpushed);
    assert!(found.reason.as_deref().unwrap().contains("1 commit is only on this machine"), "{:?}", found.reason);

    // A merge that stopped on a conflict.
    let conflicted = f.pushed(&alpha, "conflicted");
    let other = f.worktree(&alpha, "other");
    std::fs::write(other.join("conflicted.txt"), "theirs").unwrap();
    sh(&other, &["add", "."]);
    sh(&other, &["commit", "-q", "-m", "theirs"]);
    assert!(git::run(&conflicted, &["merge", "-q", &git::current_branch(&other).unwrap()]).is_err());
    assert!(matches!(f.find(&conflicted).verdict, Verdict::InProgress | Verdict::Dirty));

    // A rebase stopped halfway, with a clean tree.
    let rebasing = f.pushed(&alpha, "rebasing");
    std::fs::create_dir_all(PathBuf::from(git::run(&rebasing, &["rev-parse", "--absolute-git-dir"]).unwrap().trim()).join("rebase-merge")).unwrap();
    assert_eq!(f.find(&rebasing).verdict, Verdict::InProgress);

    // None of them is removed, even when asked for with its own token.
    for path in [&modified, &staged, &untracked, &unpushed, &conflicted, &rebasing] {
        let done = f.remove_one(f.item(&f.find(path)));
        assert_eq!(done.outcome, Outcome::Skipped, "{}", path.display());
        assert!(path.exists());
    }
}

#[test]
fn work_merged_by_squash_counts_as_recoverable() {
    let f = Fixture::new();
    let alpha = f.alpha();
    let wt = f.worktree(&alpha, "squashed");
    commit(&wt, "feature.txt");
    // The remote's main gets the same change as one commit; the branch itself was never pushed.
    let clone = f.base.join("clone");
    sh(&f.base, &["clone", "-q", f.base.join("alpha.git").to_str().unwrap(), clone.to_str().unwrap()]);
    sh(&clone, &["config", "user.email", "t@example.com"]);
    sh(&clone, &["config", "user.name", "T"]);
    commit(&clone, "feature.txt");
    sh(&clone, &["push", "-q", "origin", "main"]);
    assert_eq!(f.find(&wt).verdict, Verdict::Eligible);
}

#[test]
fn ignored_files_are_told_apart_and_local_data_needs_its_own_yes() {
    let f = Fixture::new();
    let alpha = f.alpha();
    let wt = f.pushed(&alpha, "with-env");
    std::fs::create_dir_all(wt.join("node_modules")).unwrap();
    std::fs::write(wt.join("node_modules/x.js"), "x").unwrap();
    std::fs::write(wt.join(".env"), "SECRET=1").unwrap();
    std::fs::write(wt.join("local.db"), "rows").unwrap();

    let found = f.find(&wt);
    assert_eq!(found.verdict, Verdict::IgnoredData);
    assert_eq!(found.disposable, vec!["node_modules/"]);
    assert_eq!(found.ignored_data, vec![".env", "local.db"]);
    assert!(found.reason.as_deref().unwrap().contains(".env"));

    // Not removed by default.
    let done = f.remove_one(f.item(&found));
    assert_eq!(done.outcome, Outcome::Skipped);
    assert!(wt.join(".env").exists());

    // The yes was for the files that were shown: another one voids it.
    std::fs::write(wt.join(".env"), "SECRET=2").unwrap();
    std::fs::remove_file(wt.join("local.db")).unwrap();
    let done = f.remove_one(RemoveItem { accept_ignored: true, ..f.item(&found) });
    assert_eq!(done.outcome, Outcome::Skipped);
    assert!(done.reason.as_deref().unwrap().contains("changed since it was reviewed"), "{:?}", done.reason);

    let done = f.remove_one(RemoveItem { accept_ignored: true, ..f.item(&f.find(&wt)) });
    assert_eq!(done.outcome, Outcome::Removed, "{:?}", done.reason);
    assert!(!wt.exists());
}

#[test]
fn live_work_is_never_stopped_or_removed() {
    let f = Fixture::new();
    let alpha = f.alpha();

    let waiting = f.pushed(&alpha, "waiting");
    f.session(&alpha, &waiting, TabStatus::Waiting);
    let running = f.pushed(&alpha, "running");
    f.session(&alpha, &running, TabStatus::InProgress);
    let background = f.pushed(&alpha, "background");
    let quiet = f.session(&alpha, &background, TabStatus::Idle);
    let terminal = f.pushed(&alpha, "terminal");
    let shell_only = f.pushed(&alpha, "shell-only");
    let owned = f.pushed(&alpha, "owned-terminal");
    let owner = f.session(&alpha, &owned, TabStatus::Idle);
    {
        let mut live = f.live.lock().unwrap();
        live.tabs.insert((quiet.id.clone(), quiet.tabs[0].id.clone()));
        live.panes.push(("free-terminal".into(), terminal.join("src")));
        // A session's own shell, opened somewhere else entirely.
        live.panes.push((format!("{}:1", owner.id), f.base.clone()));
    }
    // A process that changed into the worktree, started by nothing the app knows.
    let mut child = std::process::Command::new("sleep").arg("30").current_dir(&shell_only).spawn().unwrap();
    f.live.lock().unwrap().process_dirs = process_dirs();

    let expect = [(&waiting, "waiting for an answer"), (&running, "an agent is running"), (&background, "an agent is running"), (&terminal, "terminal is open"), (&owned, "a terminal is open"), (&shell_only, "process is running")];
    for (path, why) in expect {
        let found = f.find(path);
        assert_eq!(found.verdict, Verdict::Active, "{}", path.display());
        assert!(found.reason.as_deref().unwrap().contains(why), "{:?}", found.reason);
        assert_eq!(f.remove_one(f.item(&found)).outcome, Outcome::Skipped);
        assert!(path.exists());
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(f.events.0.lock().unwrap().is_empty());
}

#[test]
fn what_changed_after_the_preview_is_skipped() {
    let f = Fixture::new();
    let alpha = f.alpha();

    // A file appears.
    let edited = f.pushed(&alpha, "edited");
    let before = f.find(&edited);
    std::fs::write(edited.join("late.txt"), "late").unwrap();
    let done = f.remove_one(f.item(&before));
    assert_eq!(done.outcome, Outcome::Skipped);
    assert!(done.reason.as_deref().unwrap().contains("changed since it was reviewed"), "{:?}", done.reason);

    // A commit is made.
    let committed = f.pushed(&alpha, "committed");
    let before = f.find(&committed);
    commit(&committed, "more.txt");
    sh(&committed, &["push", "-q", "origin", "HEAD"]);
    assert_eq!(f.remove_one(f.item(&before)).outcome, Outcome::Skipped);

    // A session starts in it: it was not among the ones reviewed.
    let joined = f.pushed(&alpha, "joined");
    let before = f.find(&joined);
    let late = f.session(&alpha, &joined, TabStatus::Idle);
    let done = f.remove_one(RemoveItem { delete_sessions: true, ..f.item(&before) });
    assert_eq!(done.outcome, Outcome::Skipped);
    assert_eq!(index::get(&late.id).unwrap(), late);

    // An agent starts working.
    let woke = f.pushed(&alpha, "woke");
    let session = f.session(&alpha, &woke, TabStatus::Idle);
    let before = f.find(&woke);
    f.live.lock().unwrap().tabs.insert((session.id.clone(), session.tabs[0].id.clone()));
    assert_eq!(f.remove_one(f.item(&before)).outcome, Outcome::Skipped);

    for path in [&edited, &committed, &joined, &woke] {
        assert!(path.exists(), "{}", path.display());
    }
}

#[test]
fn deleting_conversations_is_a_separate_choice_and_touches_only_that_worktree() {
    let f = Fixture::new();
    let alpha = f.alpha();
    let gone = f.pushed(&alpha, "gone");
    let kept = f.pushed(&alpha, "kept");
    let doomed = f.session(&alpha, &gone, TabStatus::Idle);
    let neighbour = f.session(&alpha, &kept, TabStatus::Idle);
    let main = f.session(&alpha, &alpha, TabStatus::Idle);

    let done = f.remove_one(RemoveItem { delete_sessions: true, ..f.item(&f.find(&gone)) });
    assert_eq!(done.outcome, Outcome::Removed, "{:?}", done.reason);
    assert_eq!(done.sessions_deleted, vec![doomed.id.clone()]);
    assert!(index::get(&doomed.id).is_err());
    assert!(!crate::store::sessions_dir().unwrap().join(&doomed.id).exists());
    assert_eq!(index::get(&neighbour.id).unwrap(), neighbour);
    assert_eq!(index::get(&main.id).unwrap(), main);
    assert!(crate::store::sessions_dir().unwrap().join(&main.id).exists());
    assert_eq!(f.events.named("session_deleted"), vec![format!("\"{}\"", doomed.id)]);
}

#[test]
fn several_projects_are_cleaned_together_and_one_failure_does_not_stop_the_rest() {
    let mut f = Fixture::new();
    let alpha = f.alpha();
    let beta = f.project("beta");
    f.open(&f.base.join("not-there"), "missing");
    let plain = f.base.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    f.open(&plain, "plain");

    let a = f.pushed(&alpha, "shared-name");
    let b = f.pushed(&beta, "shared-name");
    let dirty = f.pushed(&beta, "dirty");
    let scanned = f.scan();
    assert_eq!(scanned.iter().map(|project| project.name.as_str()).collect::<Vec<_>>(), vec!["alpha", "beta", "missing", "plain"]);
    assert!(scanned[2].note.is_some() && scanned[3].note.is_some());
    // Each project has its main directory listed as protected, never selectable.
    for project in &scanned[..2] {
        assert_eq!(project.candidates.iter().filter(|candidate| candidate.verdict == Verdict::Protected).count(), 1, "{}", project.name);
    }

    // Narrowed to one project, the others are not read.
    let only = f.with_host(&[], None, |host| scan(host, Some(&[beta.to_string_lossy().into_owned()])).unwrap());
    assert_eq!(only.iter().map(|project| project.name.as_str()).collect::<Vec<_>>(), vec!["beta"]);

    let items = [f.item(&f.find(&a)), f.item(&f.find(&dirty)), f.item(&f.find(&b))];
    std::fs::write(dirty.join("late.txt"), "late").unwrap();
    // A worktree named under the wrong project is not that project's to remove.
    let misfiled = RemoveItem { project_path: alpha.to_string_lossy().into_owned(), ..f.item(&f.find(&b)) };
    assert_eq!(f.remove_one(misfiled).outcome, Outcome::Skipped);
    assert!(b.exists());

    let done = f.remove(&items);
    assert_eq!(done.iter().map(|item| item.outcome).collect::<Vec<_>>(), vec![Outcome::Removed, Outcome::Skipped, Outcome::Removed]);
    assert!(!a.exists() && !b.exists() && dirty.exists());
    assert!(alpha.join("a.txt").exists() && beta.join("a.txt").exists());
}

#[test]
fn a_cloud_host_removes_only_inside_its_workspace_and_never_its_root() {
    let mut f = Fixture::new();
    // The runtime's view: one workspace root holding a repository.
    let root = f.base.join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    f.projects.clear();
    let repo = root.join("repo");
    sh(&f.base, &["clone", "-q", f.base.join("alpha.git").to_str().unwrap(), repo.to_str().unwrap()]);
    sh(&repo, &["config", "user.email", "t@example.com"]);
    sh(&repo, &["config", "user.name", "T"]);
    f.open(&repo, "repo");
    let inside = f.pushed(&repo, "inside");
    let outside = f.base.join("outside");
    sh(&repo, &["worktree", "add", "-q", "-b", "elsewhere", outside.to_str().unwrap(), "origin/main"]);

    let protected = [root.clone()];
    let scanned = f.with_host(&protected, Some(&root), |host| scan(host, None).unwrap());
    let of = |path: &Path| scanned[0].candidates.iter().find(|candidate| Path::new(&candidate.path) == path).unwrap().clone();
    assert_eq!(of(&repo).verdict, Verdict::Protected);
    assert_eq!(of(&inside).verdict, Verdict::Eligible);
    assert_eq!(of(&outside).verdict, Verdict::Unverifiable);

    // A path that belongs to another host (the desktop's project) is not interpreted here.
    let local = f.alpha();
    let foreign = RemoveItem { project_path: local.to_string_lossy().into_owned(), path: local.join(".raccoon/worktrees/x").to_string_lossy().into_owned(), token: "t".into(), delete_sessions: false, accept_ignored: false };
    let items = [f.item(&of(&inside)), f.item(&of(&outside)), f.item(&of(&repo)), foreign, RemoveItem { path: root.to_string_lossy().into_owned(), ..f.item(&of(&inside)) }];
    let done = f.with_host(&protected, Some(&root), |host| remove(host, &*f.events, &items));
    assert_eq!(done.iter().map(|item| item.outcome).collect::<Vec<_>>(), vec![Outcome::Removed, Outcome::Skipped, Outcome::Skipped, Outcome::Skipped, Outcome::Skipped]);
    assert!(!inside.exists() && outside.exists() && repo.join("a.txt").exists() && local.join("a.txt").exists());
}

#[test]
fn a_retry_after_a_partial_removal_reconciles_without_removing_more() {
    let f = Fixture::new();
    let alpha = f.alpha();
    let wt = f.pushed(&alpha, "half-done");
    let session = f.session(&alpha, &wt, TabStatus::Idle);
    let main = f.session(&alpha, &alpha, TabStatus::Idle);
    let item = f.item(&f.find(&wt));
    // The first attempt removed the worktree and died before its sessions were filed.
    sh(&alpha, &["worktree", "remove", wt.to_str().unwrap()]);

    let done = f.remove_one(RemoveItem { delete_sessions: true, ..item.clone() });
    assert_eq!(done.outcome, Outcome::AlreadyRemoved, "{:?}", done.reason);
    assert_eq!(done.freed_bytes, 0);
    // Its conversation is kept even though deletion was asked for: nothing was reviewed this time.
    assert_eq!(done.sessions_kept, vec![session.id.clone()]);
    assert!(index::get(&session.id).unwrap().worktree_removed);
    assert_eq!(index::get(&main.id).unwrap(), main);

    // And once more: there is nothing left to do, and that is not called a removal.
    let again = f.remove_one(item);
    assert_eq!(again.outcome, Outcome::Skipped);
    assert!(again.sessions_kept.is_empty());
    assert_eq!(index::get(&main.id).unwrap(), main);
    assert!(alpha.join("a.txt").exists());
}

#[test]
fn a_folder_that_went_missing_is_not_taken_for_a_removed_worktree() {
    let f = Fixture::new();
    let alpha = f.alpha();
    // Moved aside (or on a volume that is not mounted): git still lists it.
    let wt = f.pushed(&alpha, "moved-aside");
    let session = f.session(&alpha, &wt, TabStatus::Idle);
    let item = f.item(&f.find(&wt));
    std::fs::rename(&wt, f.base.join("aside")).unwrap();
    let done = f.remove_one(item);
    assert_eq!(done.outcome, Outcome::Skipped, "{:?}", done.reason);
    assert_eq!(index::get(&session.id).unwrap(), session);
    assert!(git::run(&alpha, &["worktree", "list", "--porcelain"]).unwrap().contains("moved-aside"), "git's record of it is left alone");

    // A made-up path is not reported as removed, and a session in a deleted
    // subfolder of the main directory is not refiled by naming that folder.
    let gone = alpha.join("deleted-subfolder");
    let inside = f.session(&alpha, &alpha, TabStatus::Idle);
    index::update_session(&inside.id, |entry| {
        entry.cwd = gone.to_string_lossy().into_owned();
        Ok(())
    })
    .unwrap();
    let inside = index::get(&inside.id).unwrap();
    for path in [gone.clone(), f.base.join("never-existed")] {
        let forged = RemoveItem { project_path: alpha.to_string_lossy().into_owned(), path: path.to_string_lossy().into_owned(), token: "forged".into(), delete_sessions: true, accept_ignored: true };
        assert_eq!(f.remove_one(forged).outcome, Outcome::Skipped);
    }
    assert_eq!(index::get(&inside.id).unwrap(), inside);
    assert!(f.events.0.lock().unwrap().is_empty());
}

#[test]
fn a_worktree_that_holds_another_checkout_is_never_removed() {
    let f = Fixture::new();
    let alpha = f.alpha();
    std::fs::write(alpha.join(".gitignore"), "node_modules/\n.env\nlocal.db\ntarget/\n.claude/\n").unwrap();
    sh(&alpha, &["commit", "-qam", "ignore more"]);
    sh(&alpha, &["push", "-q", "origin", "main"]);

    // Another worktree of the same repository, under an ignored folder, with unsaved work.
    let outer = f.pushed(&alpha, "outer");
    let inner = outer.join("target/inner");
    sh(&alpha, &["worktree", "add", "-q", "-b", "inner", inner.to_str().unwrap(), "main"]);
    std::fs::write(inner.join("unsaved.txt"), "unsaved").unwrap();
    assert_eq!(git::run(&outer, &["status", "--porcelain"]).unwrap().trim(), "", "git sees nothing wrong with the outer one");
    let found = f.find(&outer);
    assert_eq!(found.verdict, Verdict::Protected);
    assert!(found.reason.as_deref().unwrap().contains("contains another worktree"), "{:?}", found.reason);
    assert_eq!(f.remove_one(RemoveItem { accept_ignored: true, ..f.item(&found) }).outcome, Outcome::Skipped);
    assert!(inner.join("unsaved.txt").exists());

    // A separate clone inside an ignored folder that would otherwise be disposable.
    let holder = f.pushed(&alpha, "holder");
    let clone = holder.join("node_modules/vendored/clone");
    std::fs::create_dir_all(&clone).unwrap();
    sh(&clone, &["init", "-q"]);
    std::fs::write(clone.join("work.txt"), "work").unwrap();
    let found = f.find(&holder);
    assert_eq!(found.verdict, Verdict::Unverifiable);
    assert!(found.reason.as_deref().unwrap().contains("holds another Git checkout"), "{:?}", found.reason);
    assert_eq!(f.remove_one(RemoveItem { accept_ignored: true, ..f.item(&found) }).outcome, Outcome::Skipped);
    assert!(clone.join("work.txt").exists());
}

#[test]
fn a_size_estimate_can_be_stopped_and_measures_only_worktrees() {
    let f = Fixture::new();
    let alpha = f.alpha();
    let wt = f.pushed(&alpha, "sized");
    std::fs::write(wt.join("big.bin"), vec![0u8; 64 * 1024]).unwrap();
    let jobs = SizeJobs::default();
    let project = alpha.to_string_lossy().into_owned();
    f.with_host(&[], None, |host| {
        let size = estimate_size(host, &jobs, "a", &project, wt.to_str().unwrap()).unwrap();
        assert!(size.unwrap() >= 64 * 1024);
        assert!(estimate_size(host, &jobs, "a", &project, f.base.to_str().unwrap()).is_err());
        assert!(estimate_size(host, &jobs, "a", f.base.to_str().unwrap(), wt.to_str().unwrap()).is_err());
    });
    let stop = jobs.start("peer:1");
    jobs.cancel("peer:");
    assert_eq!(walk_size(&wt, &stop), None);
    assert!(wt.join("big.bin").exists());
}
