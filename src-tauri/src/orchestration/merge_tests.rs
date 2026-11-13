//! Merging and cleanup against real temporary repositories: a lead's
//! checkout on its own branch, a worktree and a branch a worker, a bare
//! remote nothing may reach.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use super::engine::By;
use super::merge::{self, Checkouts, Options, Worktree};
use super::{store, MergeState, PendingMerge, PieceState, Run, RunMerge, RunState, SessionRef};

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(cwd).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_SYSTEM", "/dev/null").output().unwrap();
    assert!(out.status.success(), "git {args:?} in {}: {}", cwd.display(), String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A piece whose result is accepted: its id, what it depends on, the commit it was accepted as,
/// the files it changed, and its done-check.
type Accepted<'a> = (&'a str, &'a [&'a str], &'a str, &'a [&'a str], &'a str);

/// A project: `lead/` is the lead's checkout on the branch `lead`, cut from
/// `main`; `workers/<piece>/` is each worker's worktree on `piece-<piece>`.
struct Repo {
    root: tempfile::TempDir,
    mode: Mutex<String>,
    held: Mutex<Option<String>>,
    reserved: Mutex<Vec<bool>>,
    busy: Mutex<BTreeSet<String>>,
    project_check: Mutex<Option<String>>,
    /// What the forge says of open pull requests into a branch, by branch: none for a branch not listed.
    prs: Mutex<Vec<(String, Option<Vec<u64>>)>>,
    /// A pass that has reserved the checkout says so, and waits here to go on.
    hold: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    /// The workers whose agents were stopped, in order: each leaves `busy` as it is stopped.
    stopped: Mutex<Vec<String>>,
    /// The lead's session is gone (deleted with its worktree once its pull request merged).
    lead_gone: Mutex<bool>,
}

impl Repo {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let lead = root.path().join("lead");
        std::fs::create_dir_all(&lead).unwrap();
        git(root.path(), &["init", "--bare", "-q", "origin.git"]);
        git(&lead, &["init", "-q", "-b", "main"]);
        for (key, value) in [("user.name", "Lead"), ("user.email", "lead@example.test"), ("commit.gpgsign", "false")] {
            git(&lead, &["config", key, value]);
        }
        std::fs::write(lead.join("shared.txt"), "one\ntwo\nthree\n").unwrap();
        git(&lead, &["add", "."]);
        git(&lead, &["commit", "-q", "-m", "Start"]);
        git(&lead, &["remote", "add", "origin", root.path().join("origin.git").to_str().unwrap()]);
        git(&lead, &["push", "-q", "origin", "main"]);
        git(&lead, &["checkout", "-q", "-b", "lead"]);
        Self { root, mode: Mutex::new("bypassPermissions".into()), held: Mutex::new(None), reserved: Mutex::new(Vec::new()), busy: Mutex::new(BTreeSet::new()), project_check: Mutex::new(None), prs: Mutex::new(Vec::new()), hold: Mutex::new(None), stopped: Mutex::new(Vec::new()), lead_gone: Mutex::new(false) }
    }

    fn lead(&self) -> PathBuf {
        self.root.path().join("lead")
    }

    fn worker(&self, piece: &str) -> PathBuf {
        self.root.path().join("workers").join(piece)
    }

    fn head(&self) -> String {
        git(&self.lead(), &["rev-parse", "HEAD"])
    }

    /// A worker's worktree, cut from the lead's branch as it is now, with one
    /// commit that writes `files`. Returns the commit its result is accepted as.
    fn work(&self, piece: &str, files: &[(&str, &str)]) -> String {
        let path = self.worker(piece);
        git(&self.lead(), &["worktree", "add", "-q", "-b", &format!("piece-{piece}"), path.to_str().unwrap(), "lead"]);
        if !files.is_empty() {
            for (name, text) in files {
                std::fs::write(path.join(name), text).unwrap();
            }
            git(&path, &["add", "."]);
            git(&path, &["commit", "-q", "-m", &format!("Work of {piece}")]);
        }
        git(&path, &["rev-parse", "HEAD"])
    }

    /// Store a run whose pieces are all accepted.
    fn run(&self, pieces: &[Accepted], integration: Option<&str>) -> String {
        let pieces: Vec<Value> = pieces
            .iter()
            .map(|(id, on, commit, files, check)| {
                let worker = json!({"sessionId": id, "tabId": "t1"});
                json!({
                    "id": id, "title": format!("Piece {id}"), "brief": {"goal": format!("The goal of {id}")}, "owns": files, "dependsOn": on,
                    "doneChecks": [{"type": "command", "run": check}], "agent": "claude", "state": "done", "worker": worker, "branch": format!("piece-{id}"),
                    "tries": [{"step": "first", "worker": worker, "branch": format!("piece-{id}"), "outcome": "done",
                        "verification": {"gates": [], "facts": {"files": files, "changedLines": files.len(), "commit": commit}, "outcome": "passed"}}],
                })
            })
            .collect();
        let run: Run = serde_json::from_value(json!({
            "id": "run-1", "lead": {"sessionId": "lead", "tabId": "t1"}, "projectPath": self.lead(), "goal": "Bring the pieces together", "state": "merging",
            "pieces": pieces, "workerMode": "bypassPermissions", "approval": {"at": "2026-11-12T09:00:00Z"}, "integrationCheck": integration,
            "created": "2026-11-12T09:00:00Z", "modified": "2026-11-12T09:00:00Z",
        }))
        .unwrap();
        store::insert(&run).unwrap();
        run.id
    }

    fn merge(&self, skip: &[&str], recheck: bool) -> merge::Merged {
        merge::merge(self, "run-1", &self.options(By::Cli, skip, recheck)).unwrap_or_else(|error| panic!("{}: {}", error.code, error.message))
    }

    fn options(&self, by: By, skip: &[&str], recheck: bool) -> Options {
        Options { skip: skip.iter().map(|piece| piece.to_string()).collect(), recheck, by, from_lead: by == By::Cli, timeout: Duration::from_secs(60), begun: None }
    }

    fn state(&self, piece: &str) -> Option<MergeState> {
        store::get("run-1").unwrap().piece(piece).unwrap().merge.as_ref().map(|merge| merge.state)
    }

    /// Everything outside the lead's branch that a merge must leave alone.
    fn elsewhere(&self) -> String {
        let lead = self.lead();
        format!("{}\n{}\n{}", git(&lead, &["rev-parse", "main"]), git(&lead, &["ls-remote", "origin"]), git(&lead, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/piece-*", "refs/remotes"]))
    }
}

impl Checkouts for Repo {
    fn lead_checkout(&self, _run: &Run) -> anyhow::Result<PathBuf> {
        if *self.lead_gone.lock().unwrap() {
            anyhow::bail!("the lead's session is gone");
        }
        Ok(self.lead())
    }

    fn lead_mode(&self, _run: &Run) -> Option<String> {
        Some(self.mode.lock().unwrap().clone())
    }

    fn reserve(&self, _run: &Run, _cwd: &Path, by_lead: bool) -> Result<Box<dyn std::any::Any + Send>, String> {
        if let Some(why) = self.held.lock().unwrap().clone() {
            return Err(why);
        }
        self.reserved.lock().unwrap().push(by_lead);
        if let Some((begun, wait)) = self.hold.lock().unwrap().take() {
            begun.send(()).unwrap();
            wait.recv().unwrap();
        }
        Ok(Box::new(()))
    }

    fn project_check(&self, _project_path: &str) -> Option<String> {
        self.project_check.lock().unwrap().clone()
    }

    fn open_prs_into(&self, _cwd: &Path, branch: &str) -> Option<Vec<u64>> {
        self.prs.lock().unwrap().iter().find(|(name, _)| name == branch).map_or(Some(Vec::new()), |(_, prs)| prs.clone())
    }

    fn worktree(&self, worker: &SessionRef) -> Option<Worktree> {
        let path = self.worker(&worker.session_id);
        path.is_dir().then(|| Worktree { path, busy: self.busy.lock().unwrap().contains(&worker.session_id) })
    }

    fn remove(&self, _run: &Run, _worker: &SessionRef, worktree: &Worktree, still_safe: &dyn Fn() -> Result<(), String>) -> anyhow::Result<()> {
        still_safe().map_err(|why| anyhow::anyhow!(why))?;
        git(&self.lead(), &["worktree", "remove", worktree.path.to_str().unwrap()]);
        Ok(())
    }

    fn stop_agents(&self, worker: &SessionRef) -> anyhow::Result<bool> {
        let was_running = self.busy.lock().unwrap().remove(&worker.session_id);
        if was_running {
            self.stopped.lock().unwrap().push(worker.session_id.clone());
        }
        Ok(was_running)
    }

    fn changed(&self, _run: &Run) {}
}

#[test]
fn pieces_merge_in_dependency_order_one_commit_range_each_and_nothing_else_moves() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let (a, b, c) = (repo.work("a", &[("a.txt", "a\n")]), repo.work("b", &[("b.txt", "b\n")]), repo.work("c", &[("c.txt", "c\n")]));
    // A piece that only read: its worktree is where the lead's branch was.
    let read = repo.work("read", &[]);
    let log = repo.root.path().join("checked.log");
    // The plan lists them in another order than they depend on each other.
    let id = repo.run(
        &[("c", &["b"], &c, &["c.txt"], "test -f c.txt"), ("read", &[], &read, &[], "true"), ("b", &["a"], &b, &["b.txt"], "test -f b.txt"), ("a", &[], &a, &["a.txt"], "test -f a.txt")],
        Some(&format!("git log -1 --format=%s >> '{}'", log.display())),
    );
    let (start, elsewhere) = (repo.head(), repo.elsewhere());

    let merged = repo.merge(&[], false);

    assert_eq!(merged.merged.iter().map(|commit| commit.piece.as_str()).collect::<Vec<_>>(), ["read", "a", "b", "c"], "each after what it depends on, otherwise in plan order");
    assert!(merged.merged[0].nothing_to_merge && merged.merged[0].range.is_none());
    // One merge commit a piece, each on top of the one before: `before..after` is that piece's range.
    let mut at = start.clone();
    for (commit, accepted) in merged.merged[1..].iter().zip([&a, &b, &c]) {
        let merge_commit = commit.merge_commit.clone().unwrap();
        assert_eq!(commit.range.as_deref(), Some(format!("{at}..{merge_commit}").as_str()));
        assert_eq!(git(&repo.lead(), &["rev-list", "--parents", "-1", &merge_commit]), format!("{merge_commit} {at} {accepted}"));
        assert_eq!(git(&repo.lead(), &["rev-list", &format!("{at}..{merge_commit}")]).lines().count(), 2, "the piece's commit and its merge");
        at = merge_commit;
    }
    assert_eq!(repo.head(), at);
    assert_eq!((merged.head.as_str(), merged.into.as_str(), merged.done, merged.pushed), (at.as_str(), "lead", true, false));
    // The integration check ran after each merge, on that merge.
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().collect::<Vec<_>>(), ["Merge piece a: Piece a", "Merge piece b: Piece b", "Merge piece c: Piece c"]);
    let run = store::get(&id).unwrap();
    assert_eq!((run.state, run.reason.as_deref()), (RunState::Done, None));
    // Each piece's done-check was run once more on the merged result before the run was done.
    let rechecked = run.merge.as_ref().unwrap();
    assert_eq!(rechecked.final_checks.iter().map(|check| (check.piece.as_str(), check.command.run.as_str(), check.command.passed)).collect::<Vec<_>>(), [("read", "true", true), ("a", "test -f a.txt", true), ("b", "test -f b.txt", true), ("c", "test -f c.txt", true)]);
    assert_eq!(rechecked.final_head.as_deref(), Some(at.as_str()));
    // Nothing was pushed, the base branch is where it was, and every worker keeps its branch and worktree.
    assert_eq!(repo.elsewhere(), elsewhere);
    assert_eq!(git(&repo.lead(), &["status", "--porcelain"]), "");
    assert!(["a", "b", "c", "read"].iter().all(|piece| repo.worker(piece).is_dir()));
    assert_eq!(*repo.reserved.lock().unwrap(), [true], "the lead's checkout was held, once, for the whole pass");
    // Asked again, a run that is done is said as it stands and nothing is run.
    let again = repo.merge(&[], false);
    assert!(again.done && again.merged.len() == 4 && repo.head() == at);
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 3);
}

#[test]
fn a_conflict_leaves_the_leads_branch_as_it_was_and_stops_the_merge_there() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("shared.txt", "one\ntwo from a\nthree\n")]);
    let b = repo.work("b", &[("shared.txt", "one\ntwo from b\nthree\n"), ("b.txt", "b\n")]);
    let c = repo.work("c", &[("c.txt", "c\n")]);
    let id = repo.run(&[("a", &[], &a, &["shared.txt"], "true"), ("b", &[], &b, &["b.txt"], "true"), ("c", &[], &c, &["c.txt"], "true")], Some("true"));
    let elsewhere = repo.elsewhere();

    let stopped = repo.merge(&[], false);

    let after_a = stopped.merged[0].merge_commit.clone().unwrap();
    assert_eq!((stopped.conflicts.as_slice(), stopped.stopped_at.as_deref(), stopped.done), (&["b".to_string()][..], Some("b"), false));
    // The branch is where it was before the conflicting merge was tried: no merge part way, nothing changed.
    assert_eq!(repo.head(), after_a);
    assert_eq!(git(&repo.lead(), &["status", "--porcelain"]), "");
    assert!(!repo.lead().join(".git/MERGE_HEAD").exists());
    assert_eq!(std::fs::read_to_string(repo.lead().join("shared.txt")).unwrap(), "one\ntwo from a\nthree\n");
    let run = store::get(&id).unwrap();
    let conflict = run.piece("b").unwrap().merge.clone().unwrap();
    assert_eq!((conflict.state, conflict.commit.as_str(), conflict.before.as_str(), conflict.after), (MergeState::Conflict, b.as_str(), after_a.as_str(), None));
    let file = &conflict.files[0];
    assert_eq!((conflict.files.len(), file.path.as_str(), file.hunks, file.line, &file.with, file.owner.as_deref()), (1, "shared.txt", 1, Some(2), &vec!["a".to_string()], Some("a")));
    let excerpt = file.excerpt.as_deref().unwrap();
    assert!(excerpt.starts_with("<<<<<<< lead\ntwo from a\n") && excerpt.contains("=======\ntwo from b\n") && excerpt.ends_with(">>>>>>> piece-b"), "{excerpt}");
    // The piece after it was not tried: the merge stopped.
    assert_eq!(repo.state("c"), None);
    assert!(stopped.waiting.iter().any(|held| held.piece == "c" && held.why.contains("stopped at b")));
    assert!(stopped.next.contains("runs send-back b") && stopped.next.contains("--skip b"), "{}", stopped.next);
    assert_eq!(run.state, RunState::Merging);
    // What its worker is told, and what the lead is given to resolve it: the conflict and the goals, cut to fit.
    let brief = merge::brief(&run, run.piece("b").unwrap()).unwrap();
    assert!(brief.contains("- shared.txt (1 place; also changed by a (Piece a), already merged") && brief.contains("git rebase lead") && brief.contains("two from b"), "{brief}");
    let prompt = merge::resolve_prompt(&run, run.piece("b").unwrap()).unwrap();
    assert!(prompt.contains("- b (Piece b): The goal of b") && prompt.contains("- a (Piece a): The goal of a") && prompt.contains(&format!("git merge {b}")) && prompt.chars().count() <= merge::RESOLVE_LIMIT + 20, "{prompt}");

    // Left out, the pieces that do not depend on it go on. The run is not done without it.
    let skipped = repo.merge(&["b"], false);
    assert_eq!((skipped.skipped.as_slice(), repo.state("c"), skipped.done), (&["b".to_string()][..], Some(MergeState::Merged), false));
    assert_eq!(std::fs::read_to_string(repo.lead().join("shared.txt")).unwrap(), "one\ntwo from a\nthree\n");

    // The lead resolves it itself: the piece is found in its branch, checked, and the run is done.
    let lead = repo.lead();
    assert!(!Command::new("git").current_dir(&lead).args(["merge", "--no-edit", &b]).output().unwrap().status.success());
    std::fs::write(lead.join("shared.txt"), "one\ntwo from a and b\nthree\n").unwrap();
    git(&lead, &["commit", "-q", "-am", "Merge b by hand"]);
    let resolved = repo.merge(&[], false);
    let by_hand = resolved.merged.iter().find(|commit| commit.piece == "b").unwrap();
    assert!(by_hand.by_hand && by_hand.merge_commit.is_none() && resolved.done, "{:?}", resolved.next);
    assert_eq!(store::get(&id).unwrap().state, RunState::Done);
    assert_eq!(repo.elsewhere(), elsewhere);
}

#[test]
fn a_failed_integration_check_undoes_that_merge_only_and_names_the_piece() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let bad = repo.work("bad", &[("broken.txt", "x\n")]);
    let needs = repo.work("needs", &[("needs.txt", "n\n")]);
    let free = repo.work("free", &[("free.txt", "f\n")]);
    let log = repo.root.path().join("checked.log");
    let check = format!("echo ran >> '{}'; if test -f broken.txt; then echo 'broken.txt breaks the build'; exit 3; fi", log.display());
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true"), ("bad", &[], &bad, &["broken.txt"], "true"), ("needs", &["bad"], &needs, &["needs.txt"], "true"), ("free", &[], &free, &["free.txt"], "true")], Some(&check));
    let elsewhere = repo.elsewhere();

    let merged = repo.merge(&[], false);

    // Only that merge was undone: the piece before it and the one that does not depend on it are in.
    assert_eq!(merged.merged.iter().map(|commit| commit.piece.as_str()).collect::<Vec<_>>(), ["a", "free"]);
    assert_eq!((merged.integration_failed.as_slice(), merged.stopped_at.as_deref(), merged.done), (&["bad".to_string()][..], None, false));
    let lead = repo.lead();
    assert!(lead.join("a.txt").exists() && lead.join("free.txt").exists() && !lead.join("broken.txt").exists() && !lead.join("needs.txt").exists());
    assert!(!Command::new("git").current_dir(&lead).args(["merge-base", "--is-ancestor", &bad, "HEAD"]).status().unwrap().success());
    assert_eq!(git(&lead, &["status", "--porcelain"]), "");
    let run = store::get(&id).unwrap();
    let failed = run.piece("bad").unwrap().merge.clone().unwrap();
    let ran = failed.check.clone().unwrap();
    assert_eq!((failed.state, failed.before.as_str(), failed.after, ran.exit_code, ran.passed), (MergeState::IntegrationFailed, merged.merged[0].merge_commit.as_deref().unwrap(), None, Some(3), false));
    assert_eq!(ran.output.as_deref(), Some("broken.txt breaks the build"));
    // What depends on it waits for it, and says so.
    assert_eq!(repo.state("needs"), None);
    assert!(merged.waiting.iter().any(|held| held.piece == "needs" && held.on == ["bad"]));
    assert!(merged.next.contains("piece bad") && merged.next.contains("runs send-back bad"), "{}", merged.next);
    assert!(merge::brief(&run, run.piece("bad").unwrap()).unwrap().contains("exited 3. The last lines it printed:\nbroken.txt breaks the build"));
    assert_eq!(run.merge.as_ref().unwrap().pending, None);

    // The branch has moved since that merge was tried (another piece went in after it): it is tried once more there.
    let runs = || std::fs::read_to_string(&log).unwrap().lines().count();
    let before = runs();
    repo.merge(&[], false);
    assert_eq!((runs(), repo.state("bad")), (before + 1, Some(MergeState::IntegrationFailed)));
    assert!(!lead.join("broken.txt").exists() && lead.join("free.txt").exists());
    // Now nothing has changed: the same commit on the same branch is not checked again, unless asked.
    repo.merge(&[], false);
    assert_eq!(runs(), before + 1);
    repo.merge(&[], true);
    assert_eq!((runs(), repo.state("bad")), (before + 2, Some(MergeState::IntegrationFailed)));
    assert_eq!(repo.elsewhere(), elsewhere);
}

#[test]
fn undoing_a_merge_never_discards_uncommitted_work() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    // While the check runs, a file the merge did not touch is edited (by the check, or by anyone).
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true")], Some("echo edited >> shared.txt; exit 1"));
    let start = repo.head();
    let merged = repo.merge(&[], false);
    // The merge is undone, and the edit is still there.
    assert_eq!((merged.integration_failed.as_slice(), repo.head()), (&["a".to_string()][..], start.clone()));
    assert!(!repo.lead().join("a.txt").exists());
    assert_eq!(std::fs::read_to_string(repo.lead().join("shared.txt")).unwrap(), "one\ntwo\nthree\nedited\n");
    git(&repo.lead(), &["checkout", "--", "shared.txt"]);

    // An edit to a file the merge itself changed: undoing would discard it, so the merge is left in and said so.
    store::update(&id, |run| {
        run.integration_check = Some("echo edited >> a.txt; exit 1".into());
        Ok(())
    })
    .unwrap();
    let kept = repo.merge(&[], true);
    assert_eq!((kept.failed.as_slice(), kept.stopped_at.as_deref()), (&["a".to_string()][..], Some("a")));
    assert!(repo.head() != start && git(&repo.lead(), &["rev-parse", "HEAD^1"]) == start);
    assert_eq!(std::fs::read_to_string(repo.lead().join("a.txt")).unwrap(), "a\nedited\n");
    let note = store::get(&id).unwrap().piece("a").unwrap().merge.clone().unwrap().note.unwrap();
    assert!(note.contains("the merge was not undone") && note.contains("with the merge in it"), "{note}");
}

#[test]
fn a_done_check_that_fails_on_the_merged_result_keeps_the_run_from_done() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let b = repo.work("b", &[("b.txt", "b\n")]);
    // Each holds alone; together they do not.
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "test ! -f b.txt || test -f fixed.txt"), ("b", &[], &b, &["b.txt"], "test -f b.txt")], None);

    let merged = repo.merge(&[], false);

    assert_eq!((merged.merged.len(), merged.done), (2, false));
    let run = store::get(&id).unwrap();
    assert_eq!(run.state, RunState::Merging);
    let reason = run.reason.clone().unwrap();
    assert!(reason.contains("of piece a exited 1") && reason.contains("Nothing was undone"), "{reason}");
    assert!(merged.next.starts_with(&reason));
    // Fixed on the lead's branch, the checks run on the new commit and the run is done.
    std::fs::write(repo.lead().join("fixed.txt"), "ok\n").unwrap();
    git(&repo.lead(), &["add", "."]);
    git(&repo.lead(), &["commit", "-q", "-m", "Make them hold together"]);
    assert!(repo.merge(&[], false).done);
    let run = store::get(&id).unwrap();
    assert_eq!((run.state, run.reason, run.merge.unwrap().final_head), (RunState::Done, None, Some(repo.head())));
}

#[test]
fn the_project_check_is_the_integration_check_of_a_plan_that_names_none() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    *repo.project_check.lock().unwrap() = Some("test ! -f a.txt".into());
    repo.run(&[("a", &[], &a, &["a.txt"], "true")], None);
    let merged = repo.merge(&[], false);
    assert_eq!((merged.integration_check.as_deref(), merged.integration_failed.as_slice()), (Some("test ! -f a.txt"), &["a".to_string()][..]));
    assert!(store::get("run-1").unwrap().piece("a").unwrap().merge.as_ref().unwrap().check.as_ref().unwrap().project);
}

#[test]
fn a_merge_is_refused_before_anything_moves_when_the_checkout_is_not_free() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true")], Some("true"));
    let start = repo.head();
    let refused = |by: By| merge::merge(&repo, &id, &repo.options(by, &[], false)).unwrap_err();

    // Held by someone else: a pipeline's checks, a resolver, another conversation's turn.
    *repo.held.lock().unwrap() = Some("TerminalX is running a pipeline's checks in it.".into());
    let busy = refused(By::Cli);
    assert_eq!(busy.code, "checkout_busy");
    assert!(busy.message.contains("a pipeline's checks") && busy.message.contains("Nothing was merged"));
    *repo.held.lock().unwrap() = None;

    // Uncommitted work in tracked files would be lost with an undone merge.
    std::fs::write(repo.lead().join("shared.txt"), "mine\n").unwrap();
    assert_eq!(refused(By::Cli).code, "lead_checkout_dirty");
    git(&repo.lead(), &["checkout", "--", "shared.txt"]);

    // On another branch than the one the merge is for.
    store::update(&id, |run| {
        run.merge = Some(RunMerge { into: "elsewhere".into(), ..RunMerge::default() });
        Ok(())
    })
    .unwrap();
    assert_eq!(refused(By::Cli).code, "lead_branch_changed");
    // Nobody approved the plan and the lead is asked before it runs a command: the plan's commands are a person's to run.
    store::update(&id, |run| {
        (run.merge, run.approval) = (None, None);
        Ok(())
    })
    .unwrap();
    *repo.mode.lock().unwrap() = "manual".into();
    assert_eq!(refused(By::Cli).code, "checks_not_approved");
    assert_eq!((repo.head(), repo.state("a")), (start, None));
    assert_eq!(refused(By::Cli).code, "checks_not_approved");
    let merged = merge::merge(&repo, &id, &repo.options(By::Person, &[], false)).unwrap();
    assert!(merged.done);
    assert_eq!(*repo.reserved.lock().unwrap(), [true, true, false], "a person's merge waits for the lead's turn too");
    // So does a command that did not run in the lead's own conversation.
    store::update(&id, |run| {
        (run.state, run.approval) = (RunState::Merging, Some(crate::orchestration::Approval { at: "2026-11-12T09:00:00Z".into() }));
        Ok(())
    })
    .unwrap();
    merge::merge(&repo, &id, &Options { from_lead: false, ..repo.options(By::Cli, &[], false) }).unwrap();
    assert_eq!(repo.reserved.lock().unwrap().last(), Some(&false));
    assert_eq!(merge::merge(&repo, &id, &Options { skip: vec!["nope".into()], ..repo.options(By::Cli, &[], false) }).unwrap_err().code, "piece_not_found");
}

#[test]
fn a_merge_whose_check_never_finished_is_taken_back_and_made_again() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true")], Some("true"));
    // The app stopped after the merge was made and before its check ended.
    let before = repo.head();
    git(&repo.lead(), &["merge", "-q", "--no-ff", "-m", "Merge cut short", &a]);
    let cut_short = repo.head();
    store::update(&id, |run| {
        run.merge = Some(RunMerge { into: "lead".into(), pending: Some(PendingMerge { piece: "a".into(), before: before.clone(), after: Some(cut_short.clone()) }), ..RunMerge::default() });
        Ok(())
    })
    .unwrap();

    let merged = repo.merge(&[], false);

    assert!(merged.done);
    assert_eq!(merged.merged[0].range.as_deref(), Some(format!("{before}..{}", repo.head()).as_str()));
    assert_eq!(git(&repo.lead(), &["log", "-1", "--format=%s"]), "Merge piece a: Piece a");
    assert_eq!(git(&repo.lead(), &["rev-list", "--count", &format!("{before}..HEAD")]), "2");
    assert_eq!(store::get(&id).unwrap().merge.unwrap().pending, None);
}

#[test]
fn cleanup_removes_only_worktrees_whose_work_is_committed_and_merged() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let b = repo.work("b", &[("b.txt", "b\n")]);
    let c = repo.work("c", &[("c.txt", "c\n")]);
    let d = repo.work("d", &[("d.txt", "d\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true"), ("b", &[], &b, &["b.txt"], "true"), ("c", &[], &c, &["c.txt"], "true"), ("d", &[], &d, &["d.txt"], "true")], None);
    assert!(repo.merge(&[], false).done);
    // b went on after its result was accepted: a commit that is in no merge.
    std::fs::write(repo.worker("b").join("later.txt"), "more\n").unwrap();
    git(&repo.worker("b"), &["add", "."]);
    git(&repo.worker("b"), &["commit", "-q", "-m", "Later work"]);
    // c has a file nobody committed, and an agent is still running in d.
    std::fs::write(repo.worker("c").join("notes.txt"), "keep me\n").unwrap();
    repo.busy.lock().unwrap().insert("d".into());

    // Explicit: without --yes nothing goes, and what would is listed.
    let asked = merge::cleanup(&repo, &id, false).unwrap_err();
    assert_eq!(asked.code, "confirmation_required");
    assert_eq!(asked.details["wouldRemove"].as_array().unwrap().iter().map(|fate| fate["piece"].as_str().unwrap()).collect::<Vec<_>>(), ["a"]);
    assert!(asked.message.contains("Would remove 1 worktree") && asked.message.contains("Would leave 3 worktrees"), "{}", asked.message);
    assert!(["a", "b", "c", "d"].iter().all(|piece| repo.worker(piece).is_dir()));

    let cleaned = merge::cleanup(&repo, &id, true).unwrap();

    assert_eq!(cleaned.removed.iter().map(|fate| (fate.piece.as_str(), fate.attempt, fate.branch.as_deref())).collect::<Vec<_>>(), [("a", 1, Some("piece-a"))]);
    let why: Vec<(&str, &str)> = cleaned.refused.iter().map(|fate| (fate.piece.as_str(), fate.reason.as_deref().unwrap())).collect();
    assert_eq!(why, [("b", "It has 1 commit that is not in `lead`."), ("c", "It has uncommitted work in 1 file: notes.txt."), ("d", "An agent is running in it.")]);
    assert!(!repo.worker("a").exists() && repo.worker("b").is_dir() && repo.worker("c").join("notes.txt").exists() && repo.worker("d").is_dir());
    // A worktree is removed; its branch never is.
    assert_eq!(git(&repo.lead(), &["rev-parse", "piece-a"]), a);
    // While a pass merges the run, nothing is cleaned up: a merge it makes may yet be undone.
    {
        let (begun, started) = std::sync::mpsc::channel();
        let (go, wait) = std::sync::mpsc::channel::<()>();
        *repo.hold.lock().unwrap() = Some((begun, wait));
        std::thread::scope(|scope| {
            store::update(&id, |run| {
                run.state = RunState::Merging;
                Ok(())
            })
            .unwrap();
            let pass = scope.spawn(|| merge::merge(&repo, &id, &repo.options(By::Cli, &[], false)));
            started.recv().unwrap();
            assert_eq!(merge::cleanup(&repo, &id, true).unwrap_err().code, "merge_in_progress");
            go.send(()).unwrap();
            pass.join().unwrap().unwrap();
        });
    }
    // That pass ended the run again, which stopped the idle agent of d's accepted try: d goes now.
    // Asked again, what is gone is not listed and what stays still does.
    assert!(!repo.busy.lock().unwrap().contains("d"));
    let again = merge::cleanup(&repo, &id, true).unwrap();
    assert_eq!(again.removed.iter().map(|fate| fate.piece.as_str()).collect::<Vec<_>>(), ["d"]);
    assert_eq!(again.refused.iter().map(|fate| fate.piece.as_str()).collect::<Vec<_>>(), ["b", "c"]);
}

#[test]
fn a_piece_the_lead_merged_itself_is_not_undone_and_its_worker_is_told_so() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true")], Some("echo 'a.txt breaks the build'; exit 1"));
    git(&repo.lead(), &["merge", "-q", "--no-ff", "-m", "Merge a by hand", &a]);
    let by_hand = repo.head();

    let merged = repo.merge(&[], false);

    // Checked like any merge, but not TerminalX's to take back.
    assert_eq!((merged.integration_failed.as_slice(), repo.head()), (&["a".to_string()][..], by_hand));
    let run = store::get(&id).unwrap();
    let record = run.piece("a").unwrap().merge.clone().unwrap();
    assert!(record.by_hand && record.note.as_deref().unwrap().contains("nothing was undone"));
    let brief = merge::brief(&run, run.piece("a").unwrap()).unwrap();
    assert!(brief.contains("the lead merged it into `lead` itself") && brief.contains("That merge was not undone") && !brief.contains("so the merge was undone") && brief.contains("a.txt breaks the build"), "{brief}");
}

#[test]
fn a_lead_on_the_projects_base_branch_is_refused_and_the_base_branch_does_not_move() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true")], Some("true"));
    // A lead working in the project's own checkout, on main.
    git(&repo.lead(), &["checkout", "-q", "main"]);
    let (main, elsewhere) = (repo.head(), repo.elsewhere());

    let refused = merge::merge(&repo, &id, &repo.options(By::Cli, &[], false)).unwrap_err();

    assert_eq!(refused.code, "lead_on_shared_branch");
    assert_eq!(refused.message, "The lead is on `main`, the project's base branch; runs merge only into a branch of its own. Nothing was merged.");
    assert_eq!((&refused.details["branch"], &refused.details["shared"]), (&json!("main"), &json!({"kind": "base"})));
    assert!(refused.recovery.as_deref().unwrap().contains("git switch -c"));
    // Nothing touched git: main, the remote and every worker's branch are where they were, and nothing was recorded.
    assert_eq!((repo.head(), git(&repo.lead(), &["rev-parse", "main"]), repo.elsewhere()), (main.clone(), main.clone(), elsewhere));
    assert_eq!(git(&repo.lead(), &["status", "--porcelain"]), "");
    let run = store::get(&id).unwrap();
    assert_eq!((run.merge.as_ref(), repo.state("a"), run.state), (None, None, RunState::Merging));
    // A person pressing Merge is refused the same way: the branch, not who asks, decides.
    assert_eq!(merge::merge(&repo, &id, &repo.options(By::Person, &[], false)).unwrap_err().code, "lead_on_shared_branch");

    // Where the remote names its default branch, that is the base branch, whatever it is called.
    git(&repo.lead(), &["checkout", "-q", "-b", "trunk"]);
    git(&repo.lead(), &["push", "-q", "origin", "trunk"]);
    git(&repo.lead(), &["remote", "set-head", "origin", "trunk"]);
    assert_eq!(merge::merge(&repo, &id, &repo.options(By::Cli, &[], false)).unwrap_err().details["branch"], json!("trunk"));

    // On a branch of its own, cut from main in the same checkout, the pieces are merged there and main stays.
    git(&repo.lead(), &["checkout", "-q", "-b", "lead-own", "main"]);
    let merged = repo.merge(&[], false);
    assert!(merged.done && merged.into == "lead-own", "{}", merged.next);
    assert_eq!(git(&repo.lead(), &["rev-parse", "main"]), main);
    assert_eq!(git(&repo.lead(), &["rev-list", "--parents", "-1", "lead-own"]), format!("{} {main} {a}", repo.head()));
}

#[test]
fn a_branch_others_build_on_is_refused_and_a_pushed_branch_of_the_leads_own_is_not() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true")], Some("true"));
    let start = repo.head();
    let refused = || merge::merge(&repo, &id, &repo.options(By::Cli, &[], false)).unwrap_err();

    // Tracking the base branch: what is merged here is meant to go there.
    git(&repo.lead(), &["branch", "-q", "--set-upstream-to=origin/main", "lead"]);
    let tracks = refused();
    assert_eq!((tracks.code, &tracks.details["shared"]), ("lead_on_shared_branch", &json!({"kind": "tracksBase", "upstream": "origin/main"})));
    assert!(tracks.message.starts_with("The lead is on `lead`, which tracks `origin/main`, the project's base branch; runs merge only into a branch of its own."), "{}", tracks.message);

    // Pushed by the lead alone: its own branch still.
    git(&repo.lead(), &["push", "-q", "-u", "origin", "lead"]);
    *repo.prs.lock().unwrap() = vec![("lead".into(), Some(vec![42, 43]))];
    // The base of open pull requests: others' work is to be merged into it.
    let base = refused();
    assert_eq!(&base.details["shared"], &json!({"kind": "pullRequestBase", "pullRequests": [42, 43]}));
    assert!(base.message.contains("the base of open pull requests #42, #43"), "{}", base.message);
    *repo.prs.lock().unwrap() = Vec::new();

    // Someone else pushed to its upstream.
    let other = repo.root.path().join("other");
    git(repo.root.path(), &["clone", "-q", "-b", "lead", repo.root.path().join("origin.git").to_str().unwrap(), other.to_str().unwrap()]);
    for (key, value) in [("user.name", "Someone"), ("user.email", "someone@example.test"), ("commit.gpgsign", "false")] {
        git(&other, &["config", key, value]);
    }
    std::fs::write(other.join("theirs.txt"), "theirs\n").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-q", "-m", "Their work"]);
    git(&other, &["push", "-q", "origin", "lead"]);
    git(&repo.lead(), &["fetch", "-q", "origin"]);
    let pushed = refused();
    assert_eq!(&pushed.details["shared"], &json!({"kind": "pushedByOthers", "upstream": "origin/lead", "commits": 1, "by": "someone@example.test"}));
    assert!(pushed.message.contains("whose upstream `origin/lead` has 1 commit by someone else (someone@example.test)"), "{}", pushed.message);
    assert_eq!((repo.head(), repo.state("a")), (start.clone(), None), "nothing was merged while it was refused");

    // A branch of the lead's own, pushed by the lead, with a forge that cannot be asked: merged.
    git(&repo.lead(), &["checkout", "-q", "-b", "lead-two", "lead"]);
    git(&repo.lead(), &["push", "-q", "-u", "origin", "lead-two"]);
    *repo.prs.lock().unwrap() = vec![("lead-two".into(), None)];
    let merged = repo.merge(&[], false);
    assert!(merged.done && merged.into == "lead-two" && !merged.pushed, "{}", merged.next);
    assert_eq!(git(&repo.lead(), &["rev-parse", "origin/lead-two"]), start, "nothing was pushed");
}

#[test]
fn a_run_paused_on_its_budget_is_merged_and_skipped_by_hand_since_merging_asks_no_model() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("shared.txt", "one\ntwo from a\nthree\n")]);
    let b = repo.work("b", &[("shared.txt", "one\ntwo from b\nthree\n")]);
    let c = repo.work("c", &[("c.txt", "c\n")]);
    let id = repo.run(&[("a", &[], &a, &["shared.txt"], "true"), ("b", &[], &b, &["shared.txt"], "true"), ("c", &["b"], &c, &["c.txt"], "true")], Some("true"));
    // Paused on its budget, as `over_budget` leaves it when the lead was to resolve a conflict.
    let pause = || {
        store::update(&id, |run| {
            run.state = RunState::NeedsYou;
            run.reason = Some("This run has spent $4.00 of its $3.00 budget.".into());
            run.pause = Some(serde_json::from_value(json!({"kind": "dollars", "message": "This run has spent $4.00 of its $3.00 budget."})).unwrap());
            Ok(())
        })
        .unwrap()
    };
    pause();

    // A pass is git work: from the paused run it merges what merges, and stops at the conflict.
    let stopped = repo.merge(&[], false);
    assert_eq!((stopped.merged.iter().map(|commit| commit.piece.as_str()).collect::<Vec<_>>(), stopped.stopped_at.as_deref()), (vec!["a"], Some("b")));
    let after_a = repo.head();
    assert_eq!(store::get(&id).unwrap().state, RunState::NeedsYou, "still the person's: a merge needs resolving");

    // --skip works there too: b is left out, and c, which depends on it, waits.
    let skipped = repo.merge(&["b"], false);
    assert_eq!((skipped.skipped.as_slice(), repo.state("c"), repo.head()), (&["b".to_string()][..], None, after_a.clone()));
    let run = store::get(&id).unwrap();
    assert_eq!((run.state, run.pause.is_some()), (RunState::NeedsYou, true));

    // The person resolves the conflict by hand in the lead's checkout, as the over-budget message says, and merges again.
    assert!(crate::git::raw(&repo.lead(), &["merge", "-q", "--no-ff", "-m", "Merge b by hand", &b]).is_some_and(|(code, _)| code != 0));
    std::fs::write(repo.lead().join("shared.txt"), "one\ntwo from a and b\nthree\n").unwrap();
    git(&repo.lead(), &["commit", "-q", "-am", "Merge b by hand"]);
    let merged = repo.merge(&[], false);

    assert!(merged.done, "{}", merged.next);
    assert_eq!(merged.merged.iter().map(|commit| (commit.piece.as_str(), commit.by_hand)).collect::<Vec<_>>(), [("a", false), ("b", true), ("c", false)]);
    let run = store::get(&id).unwrap();
    assert_eq!((run.state, run.pause.as_ref(), run.reason.as_deref()), (RunState::Done, None, None));
    assert_eq!(std::fs::read_to_string(repo.lead().join("shared.txt")).unwrap(), "one\ntwo from a and b\nthree\n");

    // A stopped run is not: nothing more is merged in it.
    store::update(&id, |run| {
        run.state = RunState::Stopped;
        Ok(())
    })
    .unwrap();
    assert_eq!(merge::merge(&repo, &id, &repo.options(By::Cli, &[], false)).unwrap_err().code, "run_ended");
}

#[test]
fn a_piece_being_sent_back_and_a_pass_hold_the_same_lock() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true")], Some("true"));
    let start = repo.head();

    // While a piece is sent back, no pass begins: it could merge the commit going back to work.
    let sending = merge::hold_for_send_back(&id).unwrap();
    let refused = merge::merge(&repo, &id, &repo.options(By::Cli, &[], false)).unwrap_err();
    assert_eq!(refused.code, "merge_in_progress");
    assert!(refused.message.contains("being sent back to its worker"), "{}", refused.message);
    assert!(!merge::under_way(&id), "a send-back is not a merge under way");
    assert_eq!((repo.head(), repo.state("a")), (start, None));
    // Another run's send-back is no business of this one; the same run's second is refused.
    drop(merge::hold_for_send_back("run-2").unwrap());
    assert!(merge::hold_for_send_back(&id).is_err());
    drop(sending);

    // While a pass merges, a piece is not sent back.
    let (begun, started) = std::sync::mpsc::channel();
    let (go, wait) = std::sync::mpsc::channel::<()>();
    *repo.hold.lock().unwrap() = Some((begun, wait));
    std::thread::scope(|scope| {
        let pass = scope.spawn(|| merge::merge(&repo, &id, &repo.options(By::Cli, &[], false)));
        started.recv().unwrap();
        assert!(merge::under_way(&id));
        assert_eq!(merge::hold_for_send_back(&id).err().map(|error| error.code), Some("merge_in_progress"));
        go.send(()).unwrap();
        assert!(pass.join().unwrap().unwrap().done);
    });
    assert!(merge::hold_for_send_back(&id).is_ok(), "the pass let go when it ended");
}


#[test]
fn nothing_is_merged_while_a_piece_is_with_the_lead_so_its_work_is_its_own() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let b = repo.work("b", &[("b.txt", "b\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true"), ("b", &[], &b, &["b.txt"], "true")], Some("true"));
    let start = repo.head();
    // The lead took piece b over (`engine::take_over`): what it commits from here is b's result.
    store::update(&id, |run| {
        run.pieces.iter_mut().find(|piece| piece.id == "b").unwrap().state = PieceState::Lead;
        Ok(())
    })
    .unwrap();
    let refused = merge::merge(&repo, &id, &repo.options(By::Person, &[], false)).unwrap_err();
    assert_eq!((refused.code, refused.details["piece"].as_str()), ("piece_with_lead", Some("b")));
    assert_eq!(repo.head(), start, "a was not merged into the lead's branch");
}

#[test]
fn a_run_that_is_done_stops_its_finished_workers_and_cleanup_then_removes_every_merged_one() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    // `a` took two tries: the first, in `a0`, failed and committed nothing; `b` took one.
    repo.work("a0", &[]);
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let b = repo.work("b", &[("b.txt", "b\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true"), ("b", &[], &b, &["b.txt"], "true")], None);
    store::update(&id, |run| {
        let piece = run.pieces.iter_mut().find(|piece| piece.id == "a").unwrap();
        let mut first = piece.tries[0].clone();
        (first.worker, first.branch, first.outcome, first.verification) = (Some(SessionRef { session_id: "a0".into(), tab_id: Some("t1".into()) }), Some("piece-a0".into()), Some(super::Outcome::Failed), None);
        piece.tries.insert(0, first);
        Ok(())
    })
    .unwrap();
    // Each worker's turn ended with its report, and its agent sits idle in its worktree.
    repo.busy.lock().unwrap().extend(["a0".to_string(), "a".to_string(), "b".to_string()]);
    let before = merge::cleanup(&repo, &id, true).unwrap();
    assert_eq!(before.refused.iter().map(|fate| (fate.piece.as_str(), fate.attempt, fate.reason.as_deref().unwrap())).collect::<Vec<_>>(), [("a", 1, "An agent is running in it."), ("a", 2, "An agent is running in it."), ("b", 1, "An agent is running in it.")]);
    assert!(before.removed.is_empty() && repo.stopped.lock().unwrap().is_empty(), "a run that has not ended stops nothing");

    let merged = repo.merge(&[], false);

    assert!(merged.done && merged.run.state == RunState::Done);
    assert_eq!(*repo.stopped.lock().unwrap(), ["a0", "a", "b"], "the superseded try's worker and both accepted ones are stopped");
    assert!(repo.busy.lock().unwrap().is_empty());
    let cleaned = merge::cleanup(&repo, &id, true).unwrap();
    assert_eq!(cleaned.removed.iter().map(|fate| (fate.piece.as_str(), fate.attempt)).collect::<Vec<_>>(), [("a", 1), ("a", 2), ("b", 1)]);
    assert!(cleaned.refused.is_empty(), "{:?}", cleaned.refused);
    assert!(["a0", "a", "b"].iter().all(|worker| !repo.worker(worker).exists()));
    // Merged again, nothing more is stopped.
    repo.merge(&[], false);
    assert_eq!(repo.stopped.lock().unwrap().len(), 3);
}

#[test]
fn with_the_leads_session_gone_cleanup_measures_each_worktree_against_the_base_branch() {
    let _home = crate::store::temp_home();
    let repo = Repo::new();
    let a = repo.work("a", &[("a.txt", "a\n")]);
    let b = repo.work("b", &[("b.txt", "b\n")]);
    let c = repo.work("c", &[("c.txt", "c\n")]);
    let d = repo.work("d", &[("d.txt", "d\n")]);
    let id = repo.run(&[("a", &[], &a, &["a.txt"], "true"), ("b", &[], &b, &["b.txt"], "true"), ("c", &[], &c, &["c.txt"], "true"), ("d", &[], &d, &["d.txt"], "true")], None);
    assert!(repo.merge(&[], false).done);
    // The lead's pull request merged into `main`, and its session went with its worktree.
    git(&repo.lead(), &["push", "-q", "origin", "lead:main"]);
    *repo.lead_gone.lock().unwrap() = true;
    // b went on after its result was accepted; c has a file nobody committed; an agent still runs in d.
    std::fs::write(repo.worker("b").join("later.txt"), "more\n").unwrap();
    git(&repo.worker("b"), &["add", "."]);
    git(&repo.worker("b"), &["commit", "-q", "-m", "Later work"]);
    std::fs::write(repo.worker("c").join("notes.txt"), "keep me\n").unwrap();
    repo.busy.lock().unwrap().insert("d".into());

    let asked = merge::cleanup(&repo, &id, false).unwrap_err();
    assert_eq!(asked.code, "confirmation_required", "{}", asked.message);
    assert_eq!(asked.details["wouldRemove"].as_array().unwrap().iter().map(|fate| fate["piece"].as_str().unwrap()).collect::<Vec<_>>(), ["a"]);

    let cleaned = merge::cleanup(&repo, &id, true).unwrap();

    assert_eq!(cleaned.removed.iter().map(|fate| fate.piece.as_str()).collect::<Vec<_>>(), ["a"]);
    let why: Vec<(&str, &str)> = cleaned.refused.iter().map(|fate| (fate.piece.as_str(), fate.reason.as_deref().unwrap())).collect();
    assert_eq!(why, [("b", "It has 1 commit that is not in `origin/main`."), ("c", "It has uncommitted work in 1 file: notes.txt."), ("d", "An agent is running in it.")]);
    assert!(!repo.worker("a").exists() && repo.worker("b").is_dir() && repo.worker("c").join("notes.txt").exists() && repo.worker("d").is_dir());
    assert_eq!(git(&repo.lead(), &["rev-parse", "piece-a"]), a, "a worktree is removed; its branch never is");

    // b's later work merges too, and c's notes are put away: both go. With no base branch known, nothing goes.
    git(&repo.lead(), &["merge", "-q", "--no-ff", "-m", "Later work of b", "piece-b"]);
    git(&repo.lead(), &["push", "-q", "origin", "lead:main"]);
    std::fs::remove_file(repo.worker("c").join("notes.txt")).unwrap();
    git(&repo.lead(), &["branch", "-q", "-m", "main", "trunk"]);
    let unknown = merge::cleanup(&repo, &id, true).unwrap();
    assert!(unknown.removed.is_empty());
    assert!(unknown.refused.iter().filter(|fate| fate.piece != "d").all(|fate| fate.reason.as_deref().unwrap().contains("base branch is unknown")), "{:?}", unknown.refused);
    git(&repo.lead(), &["branch", "-q", "-m", "trunk", "main"]);
    let known = merge::cleanup(&repo, &id, true).unwrap();
    assert_eq!(known.removed.iter().map(|fate| fate.piece.as_str()).collect::<Vec<_>>(), ["b", "c"]);
    assert_eq!(known.refused.iter().map(|fate| (fate.piece.as_str(), fate.reason.as_deref().unwrap())).collect::<Vec<_>>(), [("d", "An agent is running in it.")]);
}
