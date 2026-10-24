//! The pipeline run end to end against a world that answers as GitHub, git
//! and the sessions would. Every way it can stop short of a merge is here,
//! and the one way it merges.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{bail, Result};
use chrono::{DateTime, TimeDelta, Utc};

use crate::github::{PinnedMerge, PrCheck, PrSnapshot};
use crate::store::index::{IssueRef, SessionEntry};
use crate::store::projects::IssuePipelineSettings;

use super::engine::{self, act, note_merge, note_tracker, poll, recover, resume, set_auto_merge, start, turn_completed, turn_failed, Action, Diff, Host, Workspace};
use super::gate::StopReason;
use super::verdict::Severity;
use super::engine::set_resolve_conflicts;
use super::{store, MergedBy, Pipeline, SessionRef, Stage, State};

const C1: &str = "1111111111111111111111111111111111111111";
const C2: &str = "2222222222222222222222222222222222222222";
const C3: &str = "3333333333333333333333333333333333333333";
const C4: &str = "4444444444444444444444444444444444444444";

type Hook = Box<dyn FnOnce() + Send>;

struct World {
    now: DateTime<Utc>,
    sessions: BTreeMap<String, SessionEntry>,
    settings: IssuePipelineSettings,
    workspace: Workspace,
    diff: Diff,
    /// The pull request as GitHub has it.
    pr: Option<PrSnapshot>,
    /// The checks a commit gets when it is pushed.
    checks: Vec<PrCheck>,
    sent: Vec<(String, String)>,
    pushes: Vec<String>,
    created: Vec<(String, String)>,
    associations: Vec<(String, String)>,
    edited: Vec<String>,
    comments: Vec<String>,
    merges: Vec<(String, String)>,
    moved_to_review: Vec<String>,
    reviewers: u32,
    conflict: bool,
    local_runs: Vec<(String, String)>,
    local_error: bool,
    during_local: Option<Hook>,
    resolution_error: Option<String>,
    reviewer_tabs: bool,
    announced: u32,
    issue_body: Option<String>,
    push_error: Option<String>,
    send_error: Option<String>,
    merge_answer: Option<PinnedMerge>,
    merge_error: Option<String>,
    /// Something that happens in the world while the pipeline is reading the diff.
    during_diff: Option<Hook>,
    /// Reads of the pull request that still show the head from before the last push.
    stale_reads: u32,
    previous_head: Option<String>,
    pauses: u32,
    settings_error: Option<String>,
    /// A merge that tells the test it has begun and waits to be let go.
    merge_hold: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
    /// A cloud workspace's runtime.
    cloud: bool,
    /// Each session's last finished turn, as its transcript has it.
    replies: BTreeMap<String, (DateTime<Utc>, String)>,
}

struct FakeHost(Mutex<World>);

fn check(name: &str, state: &str) -> PrCheck {
    PrCheck { name: name.into(), state: state.into(), url: None }
}

fn github_issue() -> IssueRef {
    IssueRef { provider: "github".into(), id: "433".into(), identifier: "#433".into(), title: "Open a pull request".into(), url: "https://github.com/acme/widgets/issues/433".into() }
}

fn linear_issue() -> IssueRef {
    IssueRef { provider: "linear".into(), id: "uuid-42".into(), identifier: "ENG-42".into(), title: "Fix login timeout".into(), url: "https://linear.app/acme/issue/ENG-42".into() }
}

fn session(id: &str, issue: Option<&IssueRef>) -> SessionEntry {
    serde_json::from_value(serde_json::json!({
        "id": id, "projectPath": "/repo", "cwd": "/repo/.raccoon/worktrees/433", "branch": "raccoon/433-open-a-pull-request",
        "worktreeName": "433-open-a-pull-request", "title": "Work", "issue": issue,
        "created": "2026-10-12T00:00:00.000Z", "modified": "2026-10-12T00:00:00.000Z",
        "tabs": [{"id": "t1", "harness": "claude", "model": "opus", "created": "2026-10-12T00:00:00.000Z"}],
    }))
    .unwrap()
}

impl FakeHost {
    fn new(issue: &IssueRef) -> Self {
        Self(Mutex::new(World {
            now: DateTime::parse_from_rfc3339("2026-10-12T10:00:00Z").unwrap().with_timezone(&Utc),
            sessions: BTreeMap::from([("author".to_string(), session("author", Some(issue)))]),
            settings: IssuePipelineSettings::default(),
            workspace: Workspace { head: C1.into(), branch: Some("raccoon/433-open-a-pull-request".into()), default_branch: Some("main".into()), dirty: Vec::new(), ahead_of_base: 2 },
            diff: Diff { paths: vec!["src/lib/format.ts".into()], patch: "+++ b/src/lib/format.ts\n+export const pad = (n: number) => String(n).padStart(2);\n".into() },
            pr: None,
            checks: vec![check("build", "success")],
            sent: Vec::new(),
            pushes: Vec::new(),
            created: Vec::new(),
            associations: Vec::new(),
            edited: Vec::new(),
            comments: Vec::new(),
            merges: Vec::new(),
            moved_to_review: Vec::new(),
            reviewers: 0,
            conflict: false,
            local_runs: Vec::new(),
            local_error: false,
            during_local: None,
            resolution_error: None,
            reviewer_tabs: false,
            announced: 0,
            issue_body: Some("Sessions stop at code.".into()),
            push_error: None,
            send_error: None,
            merge_answer: None,
            merge_error: None,
            during_diff: None,
            stale_reads: 0,
            previous_head: None,
            pauses: 0,
            settings_error: None,
            merge_hold: None,
            cloud: false,
            replies: BTreeMap::new(),
        }))
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.0.lock().unwrap()
    }

    /// The author commits: the checkout moves to `commit`.
    fn commit(&self, commit: &str) {
        self.world().workspace.head = commit.into();
    }

    fn prompts_to(&self, session_id: &str) -> Vec<String> {
        self.world().sent.iter().filter(|(to, _)| to == session_id).map(|(_, prompt)| prompt.clone()).collect()
    }

}

impl Host for FakeHost {
    fn now(&self) -> DateTime<Utc> {
        self.world().now
    }

    fn cloud(&self) -> bool {
        self.world().cloud
    }

    fn last_reply(&self, session: &SessionRef) -> Option<(DateTime<Utc>, String)> {
        self.world().replies.get(&session.session_id).cloned()
    }

    fn session(&self, session_id: &str) -> Result<SessionEntry> {
        self.world().sessions.get(session_id).cloned().ok_or_else(|| anyhow::anyhow!("session {session_id} not found"))
    }

    fn settings(&self, _project_path: &str) -> Result<IssuePipelineSettings> {
        let world = self.world();
        match &world.settings_error {
            Some(error) => bail!("{error}"),
            None => Ok(world.settings.clone()),
        }
    }

    fn pause(&self) {
        self.world().pauses += 1;
    }

    fn send(&self, to: &SessionRef, prompt: &str) -> Result<()> {
        let mut world = self.world();
        if let Some(error) = world.send_error.take() {
            bail!("{error}");
        }
        world.sent.push((to.session_id.clone(), prompt.to_string()));
        Ok(())
    }

    fn open_reviewer(&self, _pipeline: &Pipeline, author: &SessionEntry) -> Result<SessionRef> {
        let mut world = self.world();
        world.reviewers += 1;
        let id = format!("reviewer-{}", world.reviewers);
        if world.reviewer_tabs {
            let mut tab = session("unused", None).tabs.remove(0);
            tab.id = id.clone();
            tab.title = Some("Reviewer".into());
            world.sessions.get_mut(&author.id).unwrap().tabs.push(tab);
            return Ok(SessionRef { session_id: author.id.clone(), tab_id: id });
        }

        let mut entry = session(&id, None);
        entry.cwd = author.cwd.clone();
        world.sessions.insert(id.clone(), entry);
        Ok(SessionRef { session_id: id, tab_id: "t1".into() })
    }

    fn run_local_check(&self, _cwd: &Path, command: &str) -> Result<()> {
        let hook = {
            let mut world = self.world();
            let head = world.workspace.head.clone();
            world.local_runs.push((head, command.into()));
            if world.local_error { bail!("Local check command failed"); }
            world.during_local.take()
        };
        if let Some(hook) = hook { hook(); }
        Ok(())
    }

    fn resolution_needed(&self, _cwd: &Path, _branch: &str, base: &str, behind: bool) -> Result<Option<super::Resolution>> {
        let world = self.world();
        Ok((world.conflict || behind).then(|| super::Resolution { head: world.workspace.head.clone(), remote_head: world.pr.as_ref().map(|pr| pr.head_sha.clone()), base: base.into(), base_commit: "base-moved".into(), return_stage: Stage::Work }))
    }
    fn open_resolver(&self, _pipeline: &Pipeline, author: &SessionEntry) -> Result<SessionRef> {
        let mut resolver = session("resolver", None);
        resolver.cwd = author.cwd.clone();
        self.world().sessions.insert(resolver.id.clone(), resolver);
        Ok(SessionRef { session_id: "resolver".into(), tab_id: "t1".into() })
    }
    fn verify_resolution(&self, _cwd: &Path, resolution: &super::Resolution, head: &str, _branch: &str) -> Result<()> {
        let world = self.world();
        if let Some(error) = &world.resolution_error { bail!("{error}"); }
        if resolution.remote_head != world.pr.as_ref().map(|pr| pr.head_sha.clone()) { bail!("Someone pushed during resolution"); }
        if head == resolution.head { bail!("No merge commit was made"); }
        Ok(())
    }

    fn workspace(&self, _cwd: &Path) -> Result<Workspace> {
        Ok(self.world().workspace.clone())
    }

    fn base_ref(&self, _cwd: &Path, base_branch: &str) -> String {
        format!("origin/{base_branch}")
    }

    fn diff(&self, _cwd: &Path, _base: &str, _head: &str) -> Result<Diff> {
        let hook = self.world().during_diff.take();
        if let Some(hook) = hook {
            hook();
        }
        Ok(self.world().diff.clone())
    }

    fn push(&self, _cwd: &Path) -> Result<()> {
        let mut world = self.world();
        if let Some(error) = world.push_error.take() {
            bail!("{error}");
        }
        let head = world.workspace.head.clone();
        world.pushes.push(head.clone());
        let checks = world.checks.clone();
        let mut previous = None;
        if let Some(pr) = world.pr.as_mut().filter(|pr| pr.state == "OPEN") {
            previous = Some(std::mem::replace(&mut pr.head_sha, head));
            pr.checks = checks;
        }
        world.previous_head = previous;
        Ok(())
    }

    fn open_pull_request(&self, _cwd: &Path, _branch: &str) -> Result<Option<PrSnapshot>> {
        Ok(self.world().pr.clone().filter(|pr| pr.state == "OPEN"))
    }

    fn create_pull_request(&self, _cwd: &Path, title: &str, body: &str) -> Result<u64> {
        let mut world = self.world();
        world.created.push((title.to_string(), body.to_string()));
        let Some(head) = world.pushes.last().cloned() else {
            bail!("the branch was never pushed");
        };
        world.pr = Some(PrSnapshot {
            number: 7,
            url: "https://github.com/acme/widgets/pull/7".into(),
            title: title.into(),
            body: body.into(),
            state: "OPEN".into(),
            is_draft: false,
            base: "main".into(),
            head: "raccoon/433-open-a-pull-request".into(),
            head_sha: head,
            mergeable: "MERGEABLE".into(),
            merge_state: "CLEAN".into(),
            review_decision: None,
            checks: world.checks.clone(),
            required_checks: None,
            checks_unread: false,
            validation: Some(vec![check("CI", "success")]),
        });
        Ok(7)
    }

    fn associate_pull_request(&self, session_id: &str, _cwd: &Path, pr: &PrSnapshot) -> Result<()> {
        self.world().associations.push((session_id.into(), pr.url.clone()));
        Ok(())
    }

    fn pull_request(&self, _cwd: &Path, _number: u64) -> Result<PrSnapshot> {
        let mut world = self.world();
        let mut pr = world.pr.clone().ok_or_else(|| anyhow::anyhow!("no pull request"))?;
        // GitHub still showing the head from before the push.
        if world.stale_reads > 0 {
            world.stale_reads -= 1;
            if let Some(previous) = world.previous_head.clone() {
                pr.head_sha = previous;
            }
        }
        Ok(pr)
    }

    fn edit_pull_request_body(&self, _cwd: &Path, _number: u64, body: &str) -> Result<()> {
        let mut world = self.world();
        world.edited.push(body.to_string());
        if let Some(pr) = world.pr.as_mut() {
            pr.body = body.to_string();
        }
        Ok(())
    }

    fn comment(&self, _cwd: &Path, _number: u64, body: &str) -> Result<String> {
        let mut world = self.world();
        world.comments.push(body.to_string());
        Ok(format!("https://github.com/acme/widgets/pull/7#issuecomment-{}", world.comments.len()))
    }

    fn merge(&self, _cwd: &Path, _number: u64, method: &str, commit: &str) -> Result<PinnedMerge> {
        let hold = self.world().merge_hold.take();
        if let Some((begun, release)) = hold {
            begun.send(()).unwrap();
            release.recv().unwrap();
        }
        let mut world = self.world();
        world.merges.push((method.to_string(), commit.to_string()));
        if let Some(error) = world.merge_error.take() {
            bail!("{error}");
        }
        if let Some(answer) = world.merge_answer.take() {
            return Ok(answer);
        }
        let pr = world.pr.as_mut().expect("a pull request to merge");
        // GitHub's own check of `--match-head-commit`.
        if pr.head_sha != commit {
            return Ok(PinnedMerge::HeadMoved { head: pr.head_sha.clone() });
        }
        pr.state = "MERGED".into();
        Ok(PinnedMerge::Merged)
    }

    fn issue_body(&self, _project_path: &str, _issue: &IssueRef) -> Option<String> {
        self.world().issue_body.clone()
    }

    fn move_to_review(&self, issue: &IssueRef) -> Result<Option<String>> {
        if issue.provider != "linear" {
            return Ok(None);
        }
        self.world().moved_to_review.push(issue.identifier.clone());
        Ok(Some(format!("Moved {} to In Review in Linear.", issue.identifier)))
    }

    fn changed(&self, _pipeline: &Pipeline) {
        self.world().announced += 1;
    }
}

/// The author's last message of a turn.
fn done(summary: &str) -> String {
    format!("All committed.\n\n```terminalx-status\n{{\"status\": \"done\", \"checks\": \"passed\", \"summary\": \"{summary}\"}}\n```")
}

/// The reviewer's last message of a turn.
fn reviewed(commit: &str, verdict: &str, findings: &str) -> String {
    reviewed_with(commit, verdict, findings, "not_needed")
}

fn reviewed_with(commit: &str, verdict: &str, findings: &str, security: &str) -> String {
    format!("Read it.\n\n```terminalx-review\n{{\"commit\": \"{commit}\", \"verdict\": \"{verdict}\", \"securityPass\": \"{security}\", \"findings\": {findings}}}\n```")
}

const HIGH: &str = r#"[{"severity": "high", "title": "Off by one", "file": "src/lib/format.ts", "line": 3}]"#;
const LOW: &str = r#"[{"severity": "low", "title": "Name could be clearer"}]"#;

struct Run {
    _home: crate::store::TempHome,
    host: FakeHost,
    id: String,
}

impl Run {
    /// A session started from an issue, with the issue's switch as given.
    fn start(issue: &IssueRef, auto_merge: bool) -> Self {
        Self::start_in(FakeHost::new(issue), auto_merge)
    }

    fn start_in(host: FakeHost, auto_merge: bool) -> Self {
        Self::start_with(host, Some(auto_merge), None)
    }

    /// With the issue's text as the session was started with it.
    fn start_with(host: FakeHost, auto_merge: Option<bool>, issue_body: Option<&str>) -> Self {
        let home = crate::store::temp_home();
        let pipeline = start(&host, "author", "t1", auto_merge, issue_body).unwrap();
        Self { _home: home, host, id: pipeline.id }
    }

    fn pipeline(&self) -> Pipeline {
        store::get(&self.id).unwrap()
    }

    fn author(&self, message: &str) -> Pipeline {
        turn_completed(&self.host, "author", "t1", Some(message));
        self.pipeline()
    }

    /// The reviewer answers, a few minutes after it was asked.
    fn reviewer(&self, message: &str) -> Pipeline {
        self.reviewer_after(TimeDelta::minutes(4), message)
    }

    fn reviewer_after(&self, took: TimeDelta, message: &str) -> Pipeline {
        self.host.world().now += took;
        let reviewer = self.pipeline().reviewer.expect("a reviewer session");
        turn_completed(&self.host, &reviewer.session_id, &reviewer.tab_id, Some(message));
        self.pipeline()
    }

    /// Work done, pull request open, reviewer asked to read C1.
    fn to_review(&self) -> Pipeline {
        let pipeline = self.author(&done("Pads the minutes."));
        assert_eq!((pipeline.stage, pipeline.state), (Stage::Review, State::Working), "{:?}", pipeline.note);
        pipeline
    }

    /// Reviewed clean at C1, with whatever the gate then decided.
    fn to_gate(&self) -> Pipeline {
        self.to_review();
        self.reviewer(&reviewed(C1, "merge", "[]"))
    }

    fn poll(&self) -> Pipeline {
        // Past the pause between looks at a parked pipeline.
        self.host.world().now += TimeDelta::minutes(6);
        poll(&self.host);
        self.pipeline()
    }

    fn kinds(&self) -> Vec<String> {
        self.pipeline().events.iter().map(|event| event.kind.clone()).collect()
    }

    fn merges(&self) -> Vec<(String, String)> {
        self.host.world().merges.clone()
    }
}

// ---- acceptance: the switch off ------------------------------------------------

#[test]
fn with_the_switch_off_an_issue_session_ends_reviewed_and_ready_and_nothing_merges() {
    let run = Run::start(&github_issue(), false);
    let started = run.pipeline();
    assert_eq!((started.stage, started.state, started.auto_merge), (Stage::Work, State::Working, false));
    assert_eq!(started.max_rounds, 3);

    // The author reports the work done and its checks passing: TerminalX pushes and opens the pull request.
    let reviewing = run.to_review();
    assert_eq!(run.host.world().pushes, [C1]);
    assert_eq!(run.host.world().created, [("Open a pull request".to_string(), "Pads the minutes.\n\nCloses #433".to_string())]);
    let expected_url = run.host.world().pr.as_ref().unwrap().url.clone();
    assert_eq!(run.host.world().associations, [("author".into(), expected_url)]);
    let link = reviewing.pr.clone().unwrap();
    assert_eq!((link.number, link.base.as_str()), (7, "main"));

    // The reviewer is another session, in the same checkout, told the commit and not the author's account.
    let reviewer = reviewing.reviewer.clone().unwrap();
    assert_ne!(reviewer.session_id, reviewing.author.session_id);
    assert_eq!(run.host.world().sessions[&reviewer.session_id].cwd, "/repo/.raccoon/worktrees/433");
    let asked = run.host.prompts_to(&reviewer.session_id);
    assert_eq!(asked.len(), 1);
    assert!(asked[0].contains(&format!("Commit to review: {C1}")) && asked[0].contains(&format!("git diff origin/main...{C1}")));
    assert!(asked[0].contains("> Sessions stop at code."));
    assert!(!asked[0].contains("Pads the minutes"), "the reviewer is not given the author's conclusion");
    assert_eq!((reviewing.round, reviewing.review_commit.as_deref()), (1, Some(C1)));

    // A clean verdict on that commit: posted on the pull request, and left for a person.
    let ready = run.reviewer(&reviewed(C1, "merge", LOW));
    assert_eq!((ready.stage, ready.state), (Stage::Merge, State::ReadyToMerge));
    assert_eq!(ready.reason, Some(StopReason::AutoMergeOff));
    assert_eq!(ready.verdict.as_ref().unwrap().commit, C1);
    let comments = run.host.world().comments.clone();
    assert_eq!(comments.len(), 1);
    assert!(comments[0].contains("no blocking findings") && comments[0].contains("Name could be clearer"));
    assert!(run.merges().is_empty());
    assert_eq!(run.kinds(), ["started", "workDone", "pullRequest", "reviewRequested", "verdict", "findingsPosted", "readyToMerge"]);

    // Looked at again and again, it stays where it is.
    assert_eq!(run.poll().state, State::ReadyToMerge);
    assert!(run.merges().is_empty());
    // The record links the sessions and the pull request.
    let record = run.pipeline().events;
    assert_eq!(record[0].session_id.as_deref(), Some("author"));
    assert_eq!(record[2].url.as_deref(), Some("https://github.com/acme/widgets/pull/7"));
    assert_eq!((record[3].session_id.as_deref(), record[3].commit.as_deref()), (Some(reviewer.session_id.as_str()), Some(C1)));
    assert_eq!(record[5].url.as_deref(), Some("https://github.com/acme/widgets/pull/7#issuecomment-1"));
}

#[test]
fn a_session_without_an_issue_opens_reviews_and_merges_without_tracker_updates() {
    let host = FakeHost::new(&github_issue());
    host.world().sessions.get_mut("author").unwrap().issue = None;
    let run = Run::start_in(host, true);
    assert!(run.pipeline().issue.is_none());
    run.to_review();
    assert_eq!(run.host.world().created, [("Work".to_string(), "Pads the minutes.".to_string())]);
    assert!(run.host.world().moved_to_review.is_empty());
    let merged = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!(merged.state, State::Merged);
}

// ---- acceptance: the switch on --------------------------------------------------

#[test]
fn with_the_switch_on_a_clean_pull_request_merges_at_the_reviewed_commit() {
    let run = Run::start(&github_issue(), true);
    let merged = run.to_gate();
    assert_eq!((merged.stage, merged.state), (Stage::Merge, State::Merged));
    assert_eq!(run.merges(), [("merge".to_string(), C1.to_string())]);
    let record = merged.merged.unwrap();
    assert_eq!((record.commit.as_str(), record.by), (C1, MergedBy::Pipeline));
    let last = merged.events.last().unwrap();
    assert_eq!((last.kind.as_str(), last.commit.as_deref()), ("merged", Some(C1)));
    assert_eq!(last.message, "TerminalX merged pull request #7 at 1111111111 into main.");
    // Nothing merges twice.
    run.poll();
    assert_eq!(run.merges().len(), 1);
}

#[test]
fn the_projects_merge_method_is_the_one_used() {
    let host = FakeHost::new(&github_issue());
    host.world().settings.merge_method = "squash".into();
    let run = Run::start_in(host, true);
    run.to_gate();
    assert_eq!(run.merges(), [("squash".to_string(), C1.to_string())]);
}

#[test]
fn an_open_finding_goes_back_to_the_author_and_the_new_head_is_reviewed_before_it_merges() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    let addressing = run.reviewer(&reviewed(C1, "changes", HIGH));
    assert_eq!((addressing.stage, addressing.state), (Stage::Address, State::Working));
    assert!(run.merges().is_empty());
    assert!(run.host.world().comments[0].contains("changes requested") && run.host.world().comments[0].contains("Off by one"));
    let to_author = run.host.prompts_to("author");
    assert_eq!(to_author.len(), 1);
    assert!(to_author[0].contains("Off by one (`src/lib/format.ts:3`)") && to_author[0].contains("review 1 of 3") && to_author[0].contains("Do not push"));

    // The author fixes and commits; TerminalX pushes and the same reviewer reads the new head.
    run.host.commit(C2);
    let reviewing = run.author(&done("Fixed."));
    assert_eq!((reviewing.stage, reviewing.round, reviewing.review_commit.as_deref()), (Stage::Review, 2, Some(C2)));
    assert_eq!(run.host.world().pushes, [C1, C2]);
    assert_eq!(run.host.world().reviewers, 1, "one reviewer for every round");
    let reviewer = reviewing.reviewer.clone().unwrap();
    let again = run.host.prompts_to(&reviewer.session_id);
    assert_eq!(again.len(), 2);
    assert!(again[1].contains(&format!("Commit to review: {C2}")) && again[1].contains("git diff 1111111111..2222222222"));

    let merged = run.reviewer(&reviewed(C2, "merge", "[]"));
    assert_eq!(merged.state, State::Merged);
    assert_eq!(run.merges(), [("merge".to_string(), C2.to_string())]);
    assert_eq!(run.host.world().comments.len(), 2);
}

#[test]
fn an_open_finding_of_medium_or_higher_does_not_merge_even_under_a_verdict_of_merge() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    let pipeline = run.reviewer(&reviewed(C1, "merge", r#"[{"severity": "medium", "title": "Unchecked index"}]"#));
    // The findings are what count: it goes back to the author, not to GitHub.
    assert_eq!(pipeline.stage, Stage::Address);
    assert!(run.merges().is_empty());
}

#[test]
fn the_review_rounds_are_capped_and_then_it_is_a_persons() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.reviewer(&reviewed(C1, "changes", HIGH));
    run.host.commit(C2);
    run.author(&done("Second try."));
    run.reviewer(&reviewed(C2, "changes", HIGH));
    run.host.commit(C3);
    let third = run.author(&done("Third try."));
    assert_eq!((third.stage, third.round), (Stage::Review, 3));
    let stopped = run.reviewer(&reviewed(C3, "changes", HIGH));
    assert_eq!((stopped.stage, stopped.state), (Stage::Review, State::NeedsYou));
    assert_eq!(stopped.reason, Some(StopReason::RoundLimit { rounds: 3, count: 1, worst: Some(Severity::High) }));
    // The open findings stay on the page, and the author is not sent round four.
    assert_eq!(stopped.verdict.as_ref().unwrap().findings[0].title, "Off by one");
    assert_eq!(run.host.prompts_to("author").len(), 2);
    assert!(run.merges().is_empty());

    // A person may still ask for one more review; the cap was the pipeline's, not theirs.
    run.host.commit(C4);
    run.host.world().pr.as_mut().unwrap().head_sha = C4.into();
    let asked = act(&run.host, &run.id, Action::Review).unwrap();
    assert_eq!((asked.stage, asked.round, asked.max_rounds), (Stage::Review, 4, 4));
    assert_eq!(run.reviewer(&reviewed(C4, "merge", "[]")).state, State::Merged);
}

#[test]
fn a_failing_check_does_not_merge_and_a_rerun_that_passes_does() {
    let host = FakeHost::new(&github_issue());
    host.world().checks = vec![check("build", "success"), check("test", "failure")];
    let run = Run::start_in(host, true);
    let stopped = run.to_gate();
    assert_eq!((stopped.stage, stopped.state), (Stage::Merge, State::NeedsYou));
    assert_eq!(stopped.reason, Some(StopReason::ChecksFailed { names: vec!["test".into()] }));
    assert!(run.merges().is_empty());
    // The same commit, checks rerun and green: every condition now holds for it.
    run.host.world().pr.as_mut().unwrap().checks = vec![check("build", "success"), check("test", "success")];
    assert_eq!(run.poll().state, State::Merged);
    assert_eq!(run.merges(), [("merge".to_string(), C1.to_string())]);
}

#[test]
fn checks_still_running_are_waited_for_and_left_to_a_person_if_they_never_finish() {
    let host = FakeHost::new(&github_issue());
    host.world().checks = vec![check("build", "in_progress"), check("desktop (windows-latest)", "queued")];
    let run = Run::start_in(host, true);
    let waiting = run.to_gate();
    assert_eq!((waiting.stage, waiting.state), (Stage::Merge, State::Waiting));
    assert_eq!(waiting.note.as_deref(), Some("Waiting for checks on 1111111111: build and desktop (windows-latest)."));
    assert!(run.merges().is_empty());

    run.host.world().pr.as_mut().unwrap().checks[0].state = "success".into();
    let still = run.poll();
    assert_eq!(still.state, State::Waiting);
    assert_eq!(still.note.as_deref(), Some("Waiting for checks on 1111111111: desktop (windows-latest)."));

    // An hour on, the queued job has no runner and never will.
    run.host.world().now += TimeDelta::minutes(60);
    let stalled = run.poll();
    assert_eq!(stalled.state, State::NeedsYou);
    assert_eq!(stalled.reason, Some(StopReason::ChecksStalled { names: vec!["desktop (windows-latest)".into()], minutes: 60 }));
    assert!(run.merges().is_empty());

    // The project names it as a check that never holds a merge.
    run.host.world().settings.ignored_checks = vec!["windows-latest".into()];
    assert_eq!(run.poll().state, State::Merged);
}

#[test]
fn a_head_that_moved_after_the_verdict_is_not_merged_until_it_is_reviewed() {
    let run = Run::start(&github_issue(), false);
    assert_eq!(run.to_gate().state, State::ReadyToMerge);
    // Someone pushes to the branch after the review, and then turns the switch on.
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    let stopped = set_auto_merge(&run.host, &run.id, true).unwrap();
    assert_eq!(stopped.state, State::NeedsYou);
    assert_eq!(stopped.reason, Some(StopReason::HeadMoved { reviewed: C1.into(), head: C2.into() }));
    assert!(run.merges().is_empty(), "GitHub was never asked to merge the unreviewed commit");

    // Reviewing the new head is what makes it mergeable again.
    run.host.commit(C2);
    let reviewing = act(&run.host, &run.id, Action::Review).unwrap();
    assert_eq!((reviewing.stage, reviewing.review_commit.as_deref()), (Stage::Review, Some(C2)));
    assert_eq!(run.reviewer(&reviewed(C2, "merge", "[]")).state, State::Merged);
    assert_eq!(run.merges(), [("merge".to_string(), C2.to_string())]);
}

#[test]
fn a_head_that_moves_between_the_decision_and_the_merge_is_refused_by_the_pin() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    // The push lands after the pipeline read the pull request and before GitHub is asked to merge.
    run.host.world().merge_answer = Some(PinnedMerge::HeadMoved { head: C2.into() });
    let stopped = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!(run.merges(), [("merge".to_string(), C1.to_string())], "the merge named the reviewed commit");
    assert_eq!(stopped.state, State::NeedsYou);
    assert_eq!(stopped.reason, Some(StopReason::HeadMoved { reviewed: C1.into(), head: C2.into() }));
    assert!(stopped.merged.is_none());
}

#[test]
fn a_change_in_a_protected_category_is_left_for_a_person() {
    let host = FakeHost::new(&github_issue());
    host.world().diff.paths = vec!["src/lib/format.ts".into(), "saas/drizzle/0042_add_plan.sql".into()];
    let run = Run::start_in(host, true);
    let ready = run.to_gate();
    assert_eq!(ready.state, State::ReadyToMerge);
    assert!(matches!(&ready.reason, Some(StopReason::ProtectedCategory { hits }) if hits.len() == 1 && hits[0].category == "migrations" && hits[0].evidence == ["saas/drizzle/0042_add_plan.sql"]));
    assert!(run.merges().is_empty());
    // The project decides what is protected: with migrations unmarked, this one merges.
    run.host.world().settings.protected.migrations = false;
    assert_eq!(run.poll().state, State::Merged);
}

#[test]
fn anything_the_security_pass_flagged_is_left_for_a_person() {
    let host = FakeHost::new(&github_issue());
    host.world().diff = Diff { paths: vec!["src-tauri/src/auth.rs".into()], patch: String::new() };
    let run = Run::start_in(host, true);
    let reviewing = run.to_review();
    assert_eq!(reviewing.security_areas, ["authorization"]);
    let reviewer = reviewing.reviewer.unwrap();
    assert!(run.host.prompts_to(&reviewer.session_id)[0].contains("touches authorization, so a security pass is required"));
    // A low finding does not block the merge, but it was raised by the security pass.
    let ready = run.reviewer(&reviewed_with(C1, "merge", r#"[{"severity": "low", "title": "Token lifetime is long", "security": true}]"#, "flagged"));
    assert_eq!(ready.state, State::ReadyToMerge);
    assert!(matches!(&ready.reason, Some(StopReason::ProtectedCategory { hits }) if hits[0].category == "security" && hits[0].evidence == ["Token lifetime is long"]));
    assert!(run.merges().is_empty());
}

#[test]
fn a_required_security_pass_is_asked_for_once_and_then_it_is_a_persons() {
    let host = FakeHost::new(&github_issue());
    host.world().diff = Diff { paths: vec!["saas/src/billing/plans.ts".into()], patch: String::new() };
    let run = Run::start_in(host, true);
    let reviewer = run.to_review().reviewer.unwrap();
    // The reviewer answers as if no pass were needed.
    let asked = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!((asked.stage, asked.state, asked.reminded), (Stage::Review, State::Working, true));
    assert!(asked.verdict.is_none());
    let prompts = run.host.prompts_to(&reviewer.session_id);
    assert!(prompts[1].contains("the change touches billing and it reports no security pass"));
    // Again: no pass, no merge.
    let stopped = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!(stopped.reason, Some(StopReason::SecurityPassMissing { areas: vec!["billing".into()] }));
    assert!(run.merges().is_empty());
}

#[test]
fn a_required_security_pass_that_comes_back_clean_merges() {
    let host = FakeHost::new(&github_issue());
    host.world().diff = Diff { paths: vec!["saas/src/billing/plans.ts".into()], patch: String::new() };
    let run = Run::start_in(host, true);
    run.to_review();
    assert_eq!(run.reviewer(&reviewed_with(C1, "merge", "[]", "clean")).state, State::Merged);
}

#[test]
fn a_project_that_requires_a_person_never_merges_whatever_the_switch_says() {
    let host = FakeHost::new(&github_issue());
    host.world().settings.require_person = true;
    let run = Run::start_in(host, true);
    let ready = run.to_gate();
    assert_eq!((ready.state, ready.reason.clone()), (State::ReadyToMerge, Some(StopReason::PersonRequired)));
    assert!(run.merges().is_empty());
    // The person it waits for presses Merge: the reviewed commit, pinned.
    let merged = act(&run.host, &run.id, Action::Merge).unwrap();
    assert_eq!(merged.state, State::Merged);
    assert_eq!(merged.merged.unwrap().by, MergedBy::Person);
    assert_eq!(run.merges(), [("merge".to_string(), C1.to_string())]);
}

#[test]
fn a_person_pressing_merge_cannot_merge_what_the_gate_refuses() {
    let run = Run::start(&github_issue(), false);
    assert_eq!(run.to_gate().state, State::ReadyToMerge);
    // Ready when the page was drawn; a check has failed on a rerun since.
    run.host.world().pr.as_mut().unwrap().checks = vec![check("test", "failure")];
    let refused = act(&run.host, &run.id, Action::Merge).unwrap();
    assert_eq!((refused.state, refused.reason.clone()), (State::NeedsYou, Some(StopReason::ChecksFailed { names: vec!["test".into()] })));
    assert!(run.merges().is_empty());
    // And from there Merge is not on offer at all.
    assert!(act(&run.host, &run.id, Action::Merge).is_err());

    // Nor does a person's Merge reach past a head that moved after the review.
    drop(run);
    let run = Run::start(&github_issue(), false);
    run.to_gate();
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    let moved = act(&run.host, &run.id, Action::Merge).unwrap();
    assert_eq!(moved.reason, Some(StopReason::HeadMoved { reviewed: C1.into(), head: C2.into() }));
    assert!(run.merges().is_empty());
}

#[test]
fn conflicts_and_branch_protection_stop_it_and_github_refusing_is_reported_in_its_words() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    {
        let mut world = run.host.world();
        let pr = world.pr.as_mut().unwrap();
        pr.mergeable = "CONFLICTING".into();
        pr.merge_state = "DIRTY".into();
    }
    assert_eq!(run.reviewer(&reviewed(C1, "merge", "[]")).reason, Some(StopReason::Conflicts));

    {
        let mut world = run.host.world();
        let pr = world.pr.as_mut().unwrap();
        pr.mergeable = "MERGEABLE".into();
        pr.merge_state = "BLOCKED".into();
        pr.review_decision = Some("REVIEW_REQUIRED".into());
    }
    assert_eq!(run.poll().reason, Some(StopReason::ReviewRequired));
    assert!(run.merges().is_empty(), "a required review is never bypassed");

    {
        let mut world = run.host.world();
        let pr = world.pr.as_mut().unwrap();
        pr.merge_state = "CLEAN".into();
        pr.review_decision = Some("APPROVED".into());
        world.merge_answer = Some(PinnedMerge::Refused("Merge commits are not allowed on this repository.".into()));
    }
    let refused = run.poll();
    assert_eq!(refused.reason, Some(StopReason::MergeRefused { message: "Merge commits are not allowed on this repository.".into() }));
    assert_eq!(refused.state, State::NeedsYou);
}

// ---- the switch, turned off and on ----------------------------------------------

#[test]
fn turning_the_switch_off_stops_the_pipeline_before_the_merge() {
    let host = FakeHost::new(&github_issue());
    host.world().checks = vec![check("build", "in_progress")];
    let run = Run::start_in(host, true);
    assert_eq!(run.to_gate().state, State::Waiting);
    // Off while the checks run.
    let off = set_auto_merge(&run.host, &run.id, false).unwrap();
    assert!(!off.auto_merge);
    run.host.world().pr.as_mut().unwrap().checks[0].state = "success".into();
    let ready = run.poll();
    assert_eq!((ready.state, ready.reason.clone()), (State::ReadyToMerge, Some(StopReason::AutoMergeOff)));
    assert!(run.merges().is_empty());
    // And on again merges what was only waiting for it.
    let merged = set_auto_merge(&run.host, &run.id, true).unwrap();
    assert_eq!(merged.state, State::Merged);
    assert_eq!(run.kinds().iter().filter(|kind| *kind == "autoMerge").count(), 3);
    // Setting it to what it already is says nothing.
    set_auto_merge(&run.host, &run.id, true).unwrap();
    assert_eq!(run.kinds().iter().filter(|kind| *kind == "autoMerge").count(), 3);
}

#[test]
fn the_switch_turned_off_while_the_merge_step_is_reading_github_still_stops_it() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    let id = run.id.clone();
    // The step has the pull request in hand and is reading the diff when the reader flips the switch.
    run.host.world().during_diff = Some(Box::new(move || {
        store::set_switches(&id, |pipeline| pipeline.auto_merge = false).unwrap();
    }));
    // The hook must fire in the gate's read, not the review request's: that one is behind us.
    let ready = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert!(run.host.world().during_diff.is_none(), "the switch was flipped mid-step");
    assert_eq!((ready.state, ready.reason.clone()), (State::ReadyToMerge, Some(StopReason::AutoMergeOff)));
    assert!(!ready.auto_merge, "the step's commit did not write the old switch back");
    assert!(run.merges().is_empty());
}

#[test]
fn stopping_while_the_merge_step_is_reading_github_still_stops_it() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    let id = run.id.clone();
    run.host.world().during_diff = Some(Box::new(move || {
        store::set_switches(&id, |pipeline| pipeline.stopped = true).unwrap();
    }));
    let stopped = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!(stopped.state, State::Stopped);
    assert!(stopped.stopped && run.merges().is_empty());
}

#[test]
fn a_stopped_pipeline_does_nothing_until_it_is_resumed() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    let stopped = act(&run.host, &run.id, Action::Stop).unwrap();
    assert_eq!((stopped.stage, stopped.state, stopped.stopped), (Stage::Review, State::Stopped, true));
    // The reviewer finishes meanwhile: its verdict is not acted on.
    let ignored = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert!(ignored.verdict.is_none() && run.merges().is_empty() && run.host.world().comments.is_empty());
    poll(&run.host);
    assert_eq!(run.pipeline().state, State::Stopped);
    // Resumed in review: the head is reviewed again rather than trusting what was missed.
    let resumed = act(&run.host, &run.id, Action::Resume).unwrap();
    assert_eq!((resumed.stage, resumed.state, resumed.stopped, resumed.round), (Stage::Review, State::Working, false, 2));
    assert_eq!(run.reviewer(&reviewed(C1, "merge", "[]")).state, State::Merged);
}

// ---- the author's side ------------------------------------------------------------

#[test]
fn work_that_is_not_reported_done_opens_no_pull_request() {
    let run = Run::start(&github_issue(), true);
    // A reply with no status block: asked for it, once.
    let asked = run.author("I have a question about the schema.");
    assert_eq!((asked.stage, asked.state, asked.reminded), (Stage::Work, State::Working, true));
    assert!(run.host.prompts_to("author")[0].contains("did not end with the `terminalx-status` block"));
    // It says what it needs: shown on the issue page, and nothing is pushed.
    let blocked = run.author("```terminalx-status\n{\"status\": \"blocked\", \"reason\": \"Which table holds the plans?\"}\n```");
    assert_eq!(blocked.reason, Some(StopReason::AuthorNotDone { detail: "Which table holds the plans?".into() }));
    assert_eq!(blocked.note.as_deref(), Some("The author session has not reported the work done. Which table holds the plans?"));
    // Another reply without the block is not asked about a second time.
    let silent = run.author("Thanks, continuing.");
    assert_eq!(silent.state, State::NeedsYou);
    assert_eq!(run.host.prompts_to("author").len(), 1);
    assert!(run.host.world().pushes.is_empty() && run.host.world().pr.is_none());
    // Answered, the author finishes: the pipeline picks up from the stop.
    assert_eq!(run.author(&done("Done after all.")).stage, Stage::Review);
}

#[test]
fn failing_local_checks_open_no_pull_request() {
    let run = Run::start(&github_issue(), true);
    for checks in ["failed", "not_run"] {
        let stopped = run.author(&format!("```terminalx-status\n{{\"status\": \"done\", \"checks\": \"{checks}\"}}\n```"));
        assert_eq!((stopped.stage, stopped.state, stopped.reason.clone()), (Stage::Work, State::NeedsYou, Some(StopReason::LocalChecksFailed)), "{checks}");
    }
    assert!(run.host.world().pr.is_none());
    // A project with nothing to run is not held to checks it does not have.
    let reviewing = run.author("```terminalx-status\n{\"status\": \"done\", \"checks\": \"none\"}\n```");
    assert_eq!(reviewing.stage, Stage::Review);
    assert_eq!(run.host.world().created[0].1, "#433 Open a pull request\n\nCloses #433");
}

#[test]
fn uncommitted_work_and_an_empty_branch_open_no_pull_request() {
    let run = Run::start(&github_issue(), true);
    run.host.world().workspace.dirty = vec!["src/lib/format.ts".into(), "notes.txt".into()];
    let dirty = run.author(&done("Done."));
    assert_eq!((dirty.stage, dirty.state), (Stage::PullRequest, State::NeedsYou));
    assert_eq!(dirty.reason, Some(StopReason::UncommittedChanges { files: vec!["src/lib/format.ts".into(), "notes.txt".into()] }));
    assert!(run.host.world().pushes.is_empty());

    run.host.world().workspace.dirty.clear();
    run.host.world().workspace.ahead_of_base = 0;
    assert_eq!(act(&run.host, &run.id, Action::Advance).unwrap().reason, Some(StopReason::NothingToReview));

    // Committed: trying again carries on.
    run.host.world().workspace.ahead_of_base = 1;
    assert_eq!(act(&run.host, &run.id, Action::Advance).unwrap().stage, Stage::Review);
}

#[test]
fn a_pull_request_that_could_not_be_opened_is_tried_again_when_the_author_next_says_done() {
    let run = Run::start(&github_issue(), true);
    run.host.world().workspace.dirty = vec!["notes.txt".into()];
    assert_eq!(run.author(&done("Done.")).reason, Some(StopReason::UncommittedChanges { files: vec!["notes.txt".into()] }));
    // Told about it, the author answers a question first: nothing happens, and it is not nagged.
    assert_eq!(run.author("Which file do you mean?").state, State::NeedsYou);
    assert!(run.host.prompts_to("author").is_empty());
    // Then it commits the file and reports done again.
    run.host.world().workspace.dirty.clear();
    let reviewing = run.author(&done("Committed the notes too."));
    assert_eq!(reviewing.stage, Stage::Review);
    assert_eq!(run.host.world().created.len(), 1);
}

#[test]
fn a_push_that_is_refused_is_reported_and_can_be_tried_again() {
    let run = Run::start(&github_issue(), true);
    run.host.world().push_error = Some("remote: Permission to acme/widgets denied".into());
    let failed = run.author(&done("Done."));
    assert_eq!((failed.stage, failed.state), (Stage::PullRequest, State::NeedsYou));
    assert_eq!(failed.reason, Some(StopReason::Failed { step: "Pushing the branch".into(), message: "remote: Permission to acme/widgets denied".into() }));
    assert!(run.host.world().pr.is_none());
    assert_eq!(act(&run.host, &run.id, Action::Advance).unwrap().stage, Stage::Review);
}

#[test]
fn a_person_can_take_unreported_work_as_done() {
    let run = Run::start(&github_issue(), false);
    let reviewing = act(&run.host, &run.id, Action::Advance).unwrap();
    assert_eq!(reviewing.stage, Stage::Review);
    assert!(run.kinds().contains(&"workDone".to_string()));
    assert_eq!(run.host.world().created.len(), 1);
}

#[test]
fn an_author_who_changes_nothing_in_answer_to_the_review_is_not_reviewed_again() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.reviewer(&reviewed(C1, "changes", HIGH));
    // "Done", with the checkout still at the reviewed commit.
    let stopped = run.author(&done("I disagree with the finding."));
    assert_eq!((stopped.stage, stopped.state, stopped.reason.clone()), (Stage::Address, State::NeedsYou, Some(StopReason::NoChangesMade)));
    assert_eq!(run.host.world().pushes, [C1]);
    assert_eq!(stopped.round, 1);
}

#[test]
fn a_pull_request_the_session_opened_itself_is_used_and_linked_to_the_issue() {
    let host = FakeHost::new(&github_issue());
    {
        let mut world = host.world();
        world.pushes.push(C1.into());
        let checks = world.checks.clone();
        world.pr = Some(PrSnapshot {
            number: 12, url: "https://github.com/acme/widgets/pull/12".into(), title: "wip".into(), body: "Pads minutes.".into(), state: "OPEN".into(), is_draft: false,
            base: "main".into(), head: "raccoon/433-open-a-pull-request".into(), head_sha: C1.into(), mergeable: "MERGEABLE".into(), merge_state: "CLEAN".into(),
            review_decision: None, checks, required_checks: None, checks_unread: false, validation: Some(vec![check("CI", "success")]),
        });
    }
    let run = Run::start_in(host, false);
    let reviewing = run.to_review();
    assert_eq!(reviewing.pr.unwrap().number, 12);
    assert!(run.host.world().created.is_empty(), "no second pull request");
    let expected_url = run.host.world().pr.as_ref().unwrap().url.clone();
    assert_eq!(run.host.world().associations, [("author".into(), expected_url)]);
    assert_eq!(run.host.world().edited, ["Pads minutes.\n\nCloses #433"]);
    // Already linked: left alone.
    let linked = FakeHost::new(&github_issue());
    linked.world().pr = run.host.world().pr.clone();
    drop(run);
    let run = Run::start_in(linked, false);
    run.to_review();
    assert!(run.host.world().edited.is_empty());
}

// ---- the reviewer's side ----------------------------------------------------------

#[test]
fn a_reply_that_is_not_a_verdict_is_asked_for_once_and_never_taken_as_approval() {
    let run = Run::start(&github_issue(), true);
    let reviewer = run.to_review().reviewer.unwrap();
    let asked = run.reviewer("Looks good to me, ship it.");
    assert_eq!((asked.stage, asked.state, asked.reminded), (Stage::Review, State::Working, true));
    assert!(run.host.prompts_to(&reviewer.session_id)[1].contains("could not use your reply as a verdict: its reply did not end with the review block."));
    let stopped = run.reviewer("Really, it is fine.");
    assert_eq!(stopped.state, State::NeedsYou);
    assert_eq!(stopped.reason, Some(StopReason::NoVerdict { detail: "Its reply did not end with the review block.".into() }));
    assert!(stopped.verdict.is_none() && run.merges().is_empty() && run.host.world().comments.is_empty());
    // Asked again by a person, a real verdict counts.
    act(&run.host, &run.id, Action::Advance).unwrap();
    assert_eq!(run.reviewer(&reviewed(C1, "merge", "[]")).state, State::Merged);
}

#[test]
fn a_verdict_on_another_commit_is_not_a_verdict_on_this_one() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    let asked = run.reviewer(&reviewed(C3, "merge", "[]"));
    assert_eq!((asked.state, asked.reminded), (State::Working, true));
    assert!(asked.verdict.is_none());
    let stopped = run.reviewer(&reviewed(C3, "merge", "[]"));
    assert!(matches!(&stopped.reason, Some(StopReason::NoVerdict { detail }) if detail.contains("3333333333") && detail.contains("1111111111")), "{:?}", stopped.reason);
    assert!(run.merges().is_empty());
}

#[test]
fn a_reviewer_that_changes_the_checkout_voids_its_review() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    // It committed a fix of its own.
    run.host.commit(C2);
    let stopped = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert!(matches!(&stopped.reason, Some(StopReason::ReviewerChangedWorkspace { detail }) if detail.contains("2222222222")), "{:?}", stopped.reason);
    assert!(stopped.verdict.is_none() && run.merges().is_empty());
    assert_eq!(run.host.world().pushes, [C1], "the reviewer's commit is not pushed");

    // Or left edits behind.
    drop(run);
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.host.world().workspace.dirty = vec!["src/lib/format.ts".into()];
    let stopped = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert!(matches!(&stopped.reason, Some(StopReason::ReviewerChangedWorkspace { detail }) if detail.contains("src/lib/format.ts")));
    assert!(run.merges().is_empty());
}

#[test]
fn the_author_session_is_never_asked_to_review() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.reviewer(&reviewed(C1, "changes", HIGH));
    run.host.commit(C2);
    run.author(&done("Fixed."));
    let pipeline = run.pipeline();
    let reviewer = pipeline.reviewer.unwrap().session_id;
    for (to, prompt) in run.host.world().sent.iter() {
        let is_review = prompt.contains("terminalx-review");
        assert_eq!(is_review, *to == reviewer, "{to} got: {}", &prompt[..60]);
    }
    // A verdict typed into the author's own session moves nothing.
    drop(run);
    let run = Run::start(&github_issue(), true);
    run.to_review();
    let unmoved = run.author(&reviewed(C1, "merge", "[]"));
    assert_eq!((unmoved.stage, unmoved.state), (Stage::Review, State::Working));
    assert!(unmoved.verdict.is_none() && run.merges().is_empty());
}

#[test]
fn a_deleted_reviewer_is_replaced_by_a_new_one_given_the_whole_brief() {
    let run = Run::start(&github_issue(), true);
    let first = run.to_review().reviewer.unwrap();
    run.reviewer(&reviewed(C1, "changes", HIGH));
    run.host.world().sessions.remove(&first.session_id);
    run.host.commit(C2);
    let reviewing = run.author(&done("Fixed."));
    let second = reviewing.reviewer.unwrap();
    assert_ne!(second.session_id, first.session_id);
    assert!(run.host.prompts_to(&second.session_id)[0].contains("You are reviewing a pull request you did not write."));
}

#[test]
fn a_session_that_stops_mid_turn_leaves_the_stage_to_a_person() {
    let run = Run::start(&github_issue(), true);
    turn_failed(&run.host, "author", "t1", "Its turn was interrupted.");
    let stopped = run.pipeline();
    assert_eq!(stopped.reason, Some(StopReason::SessionStopped { role: "author".into(), detail: "Its turn was interrupted.".into() }));
    // The person redirects it and it finishes.
    let reviewer = run.author(&done("Done.")).reviewer.unwrap();
    turn_failed(&run.host, &reviewer.session_id, "t1", "Its agent ended before the turn finished.");
    assert_eq!(run.pipeline().reason, Some(StopReason::SessionStopped { role: "reviewer".into(), detail: "Its agent ended before the turn finished.".into() }));
    // The author being interrupted while the reviewer holds the stage is not the pipeline's business.
    act(&run.host, &run.id, Action::Advance).unwrap();
    turn_failed(&run.host, "author", "t1", "Its turn was interrupted.");
    assert_eq!(run.pipeline().state, State::Working);
}

// ---- Linear, and what happens outside ---------------------------------------------

#[test]
fn a_linear_issue_is_linked_by_its_key_and_moved_to_review() {
    let run = Run::start(&linear_issue(), false);
    let reviewing = run.to_review();
    assert_eq!(run.host.world().created, [("Fix login timeout".to_string(), "Pads the minutes.\n\nFixes ENG-42 (https://linear.app/acme/issue/ENG-42)".to_string())]);
    assert_eq!(run.host.world().moved_to_review, ["ENG-42"]);
    let tracker = reviewing.events.iter().find(|event| event.kind == "tracker").unwrap();
    assert_eq!(tracker.message, "Moved ENG-42 to In Review in Linear.");
    assert_eq!(run.reviewer(&reviewed(C1, "merge", "[]")).state, State::ReadyToMerge);
    // A GitHub issue has no state to move: the pull request's closing line is the link.
    drop(run);
    let run = Run::start(&github_issue(), false);
    run.to_review();
    assert!(run.host.world().moved_to_review.is_empty() && !run.kinds().contains(&"tracker".to_string()));
}

#[test]
fn a_merge_made_elsewhere_is_noticed_and_recorded_as_such() {
    let run = Run::start(&github_issue(), false);
    run.to_gate();
    run.host.world().pr.as_mut().unwrap().state = "MERGED".into();
    let merged = run.poll();
    assert_eq!(merged.state, State::Merged);
    assert_eq!(merged.merged.unwrap().by, MergedBy::Elsewhere);
    assert!(run.merges().is_empty());
    assert_eq!(merged.events.last().unwrap().message, "Merged outside this pipeline: pull request #7 at 1111111111 into main.");
}

#[test]
fn a_pull_request_closed_without_merging_is_reported() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.host.world().pr.as_mut().unwrap().state = "CLOSED".into();
    assert_eq!(run.reviewer(&reviewed(C1, "merge", "[]")).reason, Some(StopReason::PullRequestClosed));
    assert!(run.merges().is_empty());
}

#[test]
fn a_merge_queue_that_accepts_the_merge_is_waited_for_not_asked_twice() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.host.world().merge_answer = Some(PinnedMerge::Accepted);
    let queued = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!(queued.state, State::Waiting);
    assert_eq!(queued.merge_requested.as_ref().map(|request| request.commit.as_str()), Some(C1));
    assert_eq!(run.poll().state, State::Waiting);
    assert_eq!(run.merges().len(), 1);
    // Turning the switch off now cannot take the merge back, and the record says so rather than pretend.
    let off = set_auto_merge(&run.host, &run.id, false).unwrap();
    assert_eq!(off.events.last().unwrap().message, "GitHub had already accepted the merge of 1111111111; turning this off does not withdraw it.");
    assert_eq!(run.merges().len(), 1);
    run.host.world().pr.as_mut().unwrap().state = "MERGED".into();
    let merged = run.poll();
    assert_eq!((merged.state, merged.merged.unwrap().by), (State::Merged, MergedBy::Pipeline));
}

#[test]
fn a_merge_the_queue_never_completes_is_brought_to_a_person_and_still_noticed_if_it_lands() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.host.world().merge_answer = Some(PinnedMerge::Accepted);
    assert_eq!(run.reviewer(&reviewed(C1, "merge", "[]")).state, State::Waiting);
    run.host.world().now += TimeDelta::minutes(61);
    let stalled = run.poll();
    assert_eq!(stalled.state, State::NeedsYou);
    assert!(matches!(&stalled.reason, Some(StopReason::Failed { step, message }) if step == "Merging the pull request" && message.contains("has not completed it after 60 minutes")), "{:?}", stalled.reason);
    assert_eq!(run.merges().len(), 1, "it is not asked for a second time");
    run.host.world().pr.as_mut().unwrap().state = "MERGED".into();
    assert_eq!(run.poll().merged.unwrap().by, MergedBy::Pipeline);
}

#[test]
fn a_merge_github_refused_is_not_put_to_it_again_until_someone_asks_or_the_head_changes() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.host.world().merge_answer = Some(PinnedMerge::Refused("Merge commits are not allowed on this repository.".into()));
    assert!(matches!(run.reviewer(&reviewed(C1, "merge", "[]")).reason, Some(StopReason::MergeRefused { .. })));
    // Looked at again and again: GitHub is asked nothing more, and the reason stands.
    for _ in 0..3 {
        assert!(matches!(run.poll().reason, Some(StopReason::MergeRefused { .. })));
    }
    assert_eq!(run.merges().len(), 1);
    // The person changes the repository's setting and asks.
    assert_eq!(act(&run.host, &run.id, Action::Advance).unwrap().state, State::Merged);
    assert_eq!(run.merges().len(), 2);
}

#[test]
fn a_merge_whose_answer_was_lost_is_settled_from_the_pull_request() {
    // The request went through; only the reply did not come back.
    let run = Run::start(&github_issue(), true);
    run.to_review();
    // The gate reads an open pull request; the merge call fails; the read-back finds it merged.
    run.host.world().merge_error = Some("connection reset".into());
    let merged_after = {
        // Flip the pull request to merged exactly when the failing merge call is made.
        let (begun_tx, begun_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        run.host.world().merge_hold = Some((begun_tx, release_rx));
        let (host, reviewer) = (&run.host, run.pipeline().reviewer.unwrap());
        host.world().now += TimeDelta::minutes(4);
        std::thread::scope(|scope| {
            let step = scope.spawn(move || turn_completed(host, &reviewer.session_id, &reviewer.tab_id, Some(&reviewed(C1, "merge", "[]"))));
            begun_rx.recv().unwrap();
            host.world().pr.as_mut().unwrap().state = "MERGED".into();
            release_tx.send(()).unwrap();
            step.join().unwrap();
        });
        run.pipeline()
    };
    assert_eq!(merged_after.state, State::Merged);
    assert_eq!(merged_after.merged.unwrap().by, MergedBy::Pipeline, "it was this pipeline that asked");

    // The request never reached GitHub: nothing merged, said so, and tried again at the next look.
    drop(run);
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.host.world().merge_error = Some("could not resolve host: api.github.com".into());
    let failed = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!((failed.stage, failed.state), (Stage::Merge, State::NeedsYou));
    assert!(matches!(&failed.reason, Some(StopReason::Failed { step, .. }) if step == "Merging the pull request"));
    assert!(failed.merge_requested.is_none() && failed.merged.is_none());
    assert_eq!(run.poll().state, State::Merged);
    assert_eq!(run.merges().len(), 2);
}

#[test]
fn stop_pressed_while_github_is_merging_does_not_unmerge_the_record() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    let (begun_tx, begun_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    run.host.world().merge_hold = Some((begun_tx, release_rx));
    let (host, id, reviewer) = (&run.host, run.id.as_str(), run.pipeline().reviewer.unwrap());
    host.world().now += TimeDelta::minutes(4);
    std::thread::scope(|scope| {
        let merging = scope.spawn(move || turn_completed(host, &reviewer.session_id, &reviewer.tab_id, Some(&reviewed(C1, "merge", "[]"))));
        // GitHub has the merge request in hand when the reader presses Stop.
        begun_rx.recv().unwrap();
        let stopping = scope.spawn(move || act(host, id, Action::Stop));
        // Stop is now waiting for the step that is merging. Let the merge finish.
        while !store::get(id).unwrap().stopped {
            std::thread::yield_now();
        }
        release_tx.send(()).unwrap();
        merging.join().unwrap();
        stopping.join().unwrap().unwrap();
    });
    let after = run.pipeline();
    assert_eq!(after.state, State::Merged, "{:?}", after.note);
    assert_eq!(after.merged.unwrap().by, MergedBy::Pipeline);
    assert_eq!(run.merges().len(), 1);
}

#[test]
fn a_review_that_passed_is_not_repeated_because_github_could_not_be_read_afterwards() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    // The verdict is in; the read of the pull request that follows it fails.
    let pr = run.host.world().pr.take();
    let stuck = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!((stuck.stage, stuck.state), (Stage::Merge, State::NeedsYou));
    assert!(matches!(&stuck.reason, Some(StopReason::Failed { step, .. }) if step == "Reading the pull request"));
    assert_eq!(stuck.verdict.as_ref().map(|verdict| verdict.commit.as_str()), Some(C1));
    // GitHub is back: the next look merges, with no second review.
    run.host.world().pr = pr;
    assert_eq!(run.poll().state, State::Merged);
    assert_eq!((run.pipeline().round, run.host.world().reviewers), (1, 1));
}

#[test]
fn an_action_the_pipeline_is_in_no_position_for_is_refused_and_changes_nothing() {
    let run = Run::start(&github_issue(), true);
    let working = run.pipeline();
    // No pull request yet: nothing to review, nothing to merge.
    assert!(act(&run.host, &run.id, Action::Review).unwrap_err().to_string().contains("no pull request to review"));
    assert!(act(&run.host, &run.id, Action::Merge).unwrap_err().to_string().contains("not at Ready to merge"));
    assert_eq!(run.pipeline(), working);

    // A review under way is not asked for twice.
    let reviewing = run.to_review();
    for action in [Action::Review, Action::Advance] {
        assert!(act(&run.host, &run.id, action).unwrap_err().to_string().contains("already under way"));
    }
    assert_eq!(run.pipeline(), reviewing);
    assert_eq!(run.host.prompts_to(&reviewing.reviewer.unwrap().session_id).len(), 1);

    // Findings open and the author at work: Merge is not a way round them.
    run.reviewer(&reviewed(C1, "changes", HIGH));
    assert!(act(&run.host, &run.id, Action::Merge).is_err());
    assert_eq!(run.pipeline().stage, Stage::Address);
    assert!(run.merges().is_empty());

    // Stopped: only Resume moves it.
    act(&run.host, &run.id, Action::Stop).unwrap();
    assert!(act(&run.host, &run.id, Action::Advance).unwrap_err().to_string().contains("Resume it first"));
    act(&run.host, &run.id, Action::Resume).unwrap();

    // Merged is the end: it cannot be stopped back into something else.
    run.host.commit(C2);
    run.author(&done("Fixed."));
    let merged = run.reviewer(&reviewed(C2, "merge", "[]"));
    assert_eq!(merged.state, State::Merged);
    for action in [Action::Stop, Action::Advance, Action::Review, Action::Merge] {
        assert!(act(&run.host, &run.id, action).is_err(), "{action:?}");
    }
    assert_eq!(run.pipeline(), merged);
}

#[test]
fn github_being_unreachable_for_a_look_changes_nothing() {
    let run = Run::start(&github_issue(), false);
    let ready = run.to_gate();
    let pr = run.host.world().pr.take();
    let unchanged = run.poll();
    assert_eq!((unchanged.state, unchanged.reason.clone(), unchanged.events.len()), (State::ReadyToMerge, ready.reason, ready.events.len()));
    // A person asking for the look is told why it failed.
    assert!(act(&run.host, &run.id, Action::Refresh).is_err());
    run.host.world().pr = pr;
    assert_eq!(act(&run.host, &run.id, Action::Refresh).unwrap().state, State::ReadyToMerge);
}

// ---- starting, and starting again -------------------------------------------------

#[test]
fn a_pipeline_starts_for_any_session_on_a_branch_of_its_own() {
    let _home = crate::store::temp_home();
    let host = FakeHost::new(&github_issue());
    // The project's default for the switch is what an issue starts at.
    host.world().settings.auto_merge = true;
    host.world().settings.max_rounds = 5;
    let pipeline = start(&host, "author", "t1", None, None).unwrap();
    assert!(pipeline.auto_merge);
    assert_eq!(pipeline.max_rounds, 5);
    assert_eq!(pipeline.events.iter().map(|event| event.kind.as_str()).collect::<Vec<_>>(), ["started", "autoMerge"]);
    // Asked twice, it is the same pipeline.
    assert_eq!(start(&host, "author", "t1", Some(false), None).unwrap().id, pipeline.id);
    assert_eq!(store::list().unwrap().len(), 1);

    host.world().sessions.insert("plain".into(), session("plain", None));
    assert!(start(&host, "plain", "t1", None, None).unwrap().issue.is_none());
    assert!(start(&host, "author", "nope", None, None).is_err());

    host.world().sessions.insert("main".into(), session("main", Some(&github_issue())));
    host.world().workspace.branch = Some("main".into());
    assert!(start(&host, "main", "t1", None, None).unwrap_err().to_string().contains("runs on main itself"));

    host.world().workspace.branch = Some("raccoon/other".into());
    host.world().settings.enabled = false;
    assert!(start(&host, "main", "t1", None, None).unwrap_err().to_string().contains("turned off for this project"));
    assert_eq!(store::list().unwrap().len(), 2);
}

#[test]
fn a_turn_ending_in_a_session_outside_any_pipeline_does_nothing() {
    let run = Run::start(&github_issue(), true);
    turn_completed(&run.host, "someone-else", "t1", Some(&done("Done.")));
    // The author's other tab is not the conversation the pipeline listens to.
    turn_completed(&run.host, "author", "t2", Some(&done("Done.")));
    let untouched = run.pipeline();
    assert_eq!((untouched.stage, untouched.events.len()), (Stage::Work, 2));
    assert!(run.host.world().pushes.is_empty());
}

#[test]
fn after_a_restart_a_stage_that_was_in_flight_says_so() {
    let run = Run::start(&github_issue(), true);
    recover(&run.host);
    assert_eq!(run.pipeline().reason, Some(StopReason::SessionStopped { role: "author".into(), detail: "TerminalX was closed before it finished.".into() }));
    run.author(&done("Done."));
    recover(&run.host);
    let stopped = run.pipeline();
    assert_eq!((stopped.stage, stopped.reason.clone()), (Stage::Review, Some(StopReason::SessionStopped { role: "reviewer".into(), detail: "TerminalX was closed before it finished.".into() })));
    // Something that had come to rest is left as it was.
    assert_eq!(act(&run.host, &run.id, Action::Advance).unwrap().state, State::Working);
    let merged = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!(merged.state, State::Merged);
    recover(&run.host);
    assert_eq!(run.pipeline(), merged);
}

#[test]
fn a_step_that_changes_nothing_writes_and_announces_nothing() {
    let run = Run::start(&github_issue(), false);
    let ready = run.to_gate();
    let announced = run.host.world().announced;
    let again = run.poll();
    assert_eq!((again.modified, run.host.world().announced), (ready.modified, announced));
}

#[test]
fn a_prompt_that_cannot_be_delivered_does_not_use_up_a_review_round() {
    let run = Run::start(&github_issue(), true);
    run.host.world().send_error = Some("the agent is not running".into());
    let failed = run.author(&done("Done."));
    assert_eq!((failed.stage, failed.state, failed.round), (Stage::Review, State::NeedsYou, 0));
    assert_eq!(failed.reason, Some(StopReason::Failed { step: "Starting the review".into(), message: "the agent is not running".into() }));
    let retried = act(&run.host, &run.id, Action::Advance).unwrap();
    assert_eq!((retried.state, retried.round), (State::Working, 1));
}

/// The issue page reads pipelines as this file spells them:
/// `src/lib/issuePipeline.test.ts` loads the same one. A field added here
/// changes what is written, this test fails until the file says so too, and
/// then that test fails until the page knows the field.
#[test]
fn a_pipeline_is_stored_in_the_shape_the_issue_page_reads() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
    let pipeline: Pipeline = serde_json::from_value(fixture.clone()).unwrap();
    assert_eq!(serde_json::to_value(&pipeline).unwrap(), fixture);
    assert_eq!((pipeline.stage, pipeline.state), (Stage::Review, State::NeedsYou));
    assert_eq!(pipeline.reason, Some(StopReason::RoundLimit { rounds: 3, count: 2, worst: Some(Severity::High) }));
    // And the sentence in it is the one the engine writes for that reason.
    assert_eq!(pipeline.note.as_deref(), pipeline.reason.as_ref().map(StopReason::describe).as_deref());

    // What the engine itself produces has the same keys, at every level the page reads.
    let run = Run::start(&github_issue(), true);
    run.host.world().diff = Diff { paths: vec!["src-tauri/src/auth.rs".into()], patch: String::new() };
    run.to_review();
    let findings = r#"[{"severity": "high", "title": "Token is logged", "detail": "It reaches the log.", "file": "src/auth.rs", "line": 42, "security": true}]"#;
    let produced = serde_json::to_value(run.reviewer(&reviewed_with(C1, "changes", findings, "flagged"))).unwrap();
    let keys = |value: &serde_json::Value| value.as_object().map(|object| object.keys().cloned().collect::<std::collections::BTreeSet<_>>()).unwrap_or_default();
    // The two are in different states, so only what both always carry is compared at the top.
    let optional = ["reason", "note", "summary", "reviewCommit", "reviewRequestedAt", "verdict", "reviewer", "pr", "waitingSince", "mergeRequested", "mergeRefused", "merged"];
    let always = |value: &serde_json::Value| keys(value).into_iter().filter(|key| !optional.contains(&key.as_str())).collect::<Vec<_>>();
    assert_eq!(always(&produced), always(&fixture));
    for part in ["issue", "author", "reviewer", "pr", "verdict"] {
        assert_eq!(keys(&produced[part]), keys(&fixture[part]), "{part}");
    }
    assert_eq!(keys(&produced["verdict"]["findings"][0]), keys(&fixture["verdict"]["findings"][0]));
    assert_eq!(keys(&produced["events"][0]), keys(&fixture["events"][0]));
}

// ---- what the review of this change found ------------------------------------------

#[test]
fn missing_validation_never_becomes_success_with_age_and_no_ci_requires_opt_in() {
    let host = FakeHost::new(&github_issue());
    host.world().checks = Vec::new();
    let run = Run::start_in(host, true);
    assert_eq!(run.to_gate().state, State::Waiting);
    run.host.world().now += TimeDelta::minutes(10);
    assert_eq!(run.poll().state, State::Waiting);
    assert!(run.merges().is_empty());
    run.host.world().settings.allow_no_ci = true;
    run.host.world().pr.as_mut().unwrap().validation = Some(Vec::new());
    assert_eq!(run.poll().state, State::Merged);
}

#[test]
fn queued_workflows_partial_checks_and_pending_reruns_hold_the_pipeline() {
    for checks in [vec![], vec![check("build", "success")], vec![check("build", "success"), check("test", "success")]] {
        let run = Run::start(&github_issue(), true);
        run.to_review();
        {
            let mut world = run.host.world();
            let pr = world.pr.as_mut().unwrap();
            pr.checks = checks;
            pr.validation = Some(vec![check("CI workflow", "queued")]);
        }
        assert_eq!(run.reviewer_after(TimeDelta::minutes(10), &reviewed(C1, "merge", "[]")).state, State::Waiting);
        assert!(run.merges().is_empty());
        {
            let mut world = run.host.world();
            let pr = world.pr.as_mut().unwrap();
            pr.checks = vec![check("build", "success"), check("test", "success")];
            pr.validation = Some(vec![check("CI workflow", "success")]);
        }
        assert_eq!(run.poll().state, State::Merged);
        assert_eq!(run.merges(), [("merge".into(), C1.into())]);
    }
}

#[test]
fn only_the_pipelines_own_branch_is_ever_pushed() {
    // The author's session was moved to the project's own checkout, on main, and commits there.
    let run = Run::start(&github_issue(), true);
    assert_eq!(run.pipeline().branch, "raccoon/433-open-a-pull-request");
    run.host.world().workspace.branch = Some("main".into());
    let stopped = run.author(&done("Done."));
    assert_eq!(stopped.reason, Some(StopReason::WorkspaceMoved { expected: "raccoon/433-open-a-pull-request".into(), found: "main".into() }));
    assert_eq!(stopped.note.as_deref(), Some("The session's checkout is on main, not on raccoon/433-open-a-pull-request, the branch this pull request is opened from. Nothing was pushed."));
    assert!(run.host.world().pushes.is_empty() && run.host.world().pr.is_none());
    // A person pressing on does not push it either.
    assert!(matches!(act(&run.host, &run.id, Action::Advance).unwrap().reason, Some(StopReason::WorkspaceMoved { .. })));
    assert!(run.host.world().pushes.is_empty());

    // The same after a review, when the fixes would be pushed.
    drop(run);
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.reviewer(&reviewed(C1, "changes", HIGH));
    run.host.world().workspace.branch = None;
    run.host.commit(C2);
    let stopped = run.author(&done("Fixed."));
    assert_eq!(stopped.reason, Some(StopReason::WorkspaceMoved { expected: "raccoon/433-open-a-pull-request".into(), found: "no branch".into() }));
    assert_eq!(run.host.world().pushes, [C1]);
}

#[test]
fn a_pull_request_that_still_shows_the_old_head_after_a_push_is_given_a_moment() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.reviewer(&reviewed(C1, "changes", HIGH));
    run.host.commit(C2);
    // GitHub shows the push on the pull request two reads late.
    run.host.world().stale_reads = 2;
    let reviewing = run.author(&done("Fixed."));
    assert_eq!((reviewing.stage, reviewing.state, reviewing.review_commit.as_deref()), (Stage::Review, State::Working, Some(C2)));
    assert_eq!(run.host.world().pauses, 2);

    // One that never catches up is a real difference, and is said to be.
    run.reviewer(&reviewed(C2, "changes", HIGH));
    run.host.commit(C3);
    run.host.world().stale_reads = 100;
    let stuck = run.author(&done("Fixed again."));
    assert!(matches!(&stuck.reason, Some(StopReason::Failed { step, message }) if step == "Starting the review" && message.contains("The workspace is at 3333333333 and the pull request is at 2222222222")), "{:?}", stuck.reason);
    assert_eq!(stuck.round, 2);
}

#[test]
fn a_pull_request_merged_or_closed_by_hand_is_noticed_at_any_stage() {
    // The author disputes the finding and changes nothing; the person agrees and merges on GitHub.
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.reviewer(&reviewed(C1, "changes", HIGH));
    assert_eq!(run.author(&done("The finding is wrong.")).reason, Some(StopReason::NoChangesMade));
    assert_eq!(run.poll().stage, Stage::Address, "an open pull request is left as it is");
    run.host.world().pr.as_mut().unwrap().state = "MERGED".into();
    let merged = run.poll();
    assert_eq!((merged.state, merged.merged.as_ref().unwrap().by), (State::Merged, MergedBy::Elsewhere));

    // Closed without merging, with the round limit reached.
    drop(run);
    let host = FakeHost::new(&github_issue());
    host.world().settings.max_rounds = 1;
    let run = Run::start_in(host, true);
    run.to_review();
    assert!(matches!(run.reviewer(&reviewed(C1, "changes", HIGH)).reason, Some(StopReason::RoundLimit { .. })));
    run.host.world().pr.as_mut().unwrap().state = "CLOSED".into();
    assert_eq!(run.poll().reason, Some(StopReason::PullRequestClosed));
}

#[test]
fn findings_that_never_reached_the_author_are_sent_again_not_skipped() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    run.host.world().send_error = Some("the agent is not running".into());
    let failed = run.reviewer(&reviewed(C1, "changes", HIGH));
    assert_eq!((failed.stage, failed.state, failed.findings_sent_round), (Stage::Address, State::NeedsYou, 0));
    assert!(matches!(&failed.reason, Some(StopReason::Failed { step, .. }) if step == "Sending the findings to the author"));
    assert!(run.host.prompts_to("author").is_empty());
    let sent = act(&run.host, &run.id, Action::Advance).unwrap();
    assert_eq!((sent.stage, sent.state, sent.findings_sent_round), (Stage::Address, State::Working, 1));
    assert!(run.host.prompts_to("author")[0].contains("Off by one"));
}

#[test]
fn settings_that_cannot_be_read_never_let_a_merge_through() {
    // The project keeps the merge for a person; then its settings become unreadable.
    let host = FakeHost::new(&github_issue());
    host.world().settings.require_person = true;
    let run = Run::start_in(host, true);
    run.to_review();
    run.host.world().settings_error = Some("The project at /repo is no longer attached.".into());
    let stopped = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!(stopped.state, State::NeedsYou);
    assert!(matches!(&stopped.reason, Some(StopReason::Failed { step, message }) if step == "Reading the project's settings" && message.contains("Nothing is merged automatically")), "{:?}", stopped.reason);
    assert!(run.merges().is_empty());
    // Readable again, the project's own rule applies.
    run.host.world().settings_error = None;
    assert_eq!(run.poll().reason, Some(StopReason::PersonRequired));
    assert!(run.merges().is_empty());
    // And a pipeline is not started on a guess at the settings.
    let other = FakeHost::new(&github_issue());
    other.world().settings_error = Some("unreadable".into());
    other.world().sessions.insert("second".into(), session("second", Some(&github_issue())));
    assert!(start(&other, "second", "t1", None, None).unwrap_err().to_string().contains("settings could not be read"));
}

#[test]
fn the_record_keeps_its_newest_lines() {
    let mut pipeline = {
        let run = Run::start(&github_issue(), false);
        run.pipeline()
    };
    for n in 0..300 {
        pipeline.record("2026-10-12T00:00:00.000Z", "note", format!("line {n}"));
    }
    assert_eq!(pipeline.events.len(), 200);
    assert_eq!(pipeline.events.last().unwrap().message, "line 299");
    let _ = engine::CHECKS_WAIT_MINUTES;
}

// ---- a cloud workspace ------------------------------------------------------------

/// A cloud workspace's runtime: it cannot read the tracker, and never merges.
fn cloud_host(issue: &IssueRef) -> FakeHost {
    let host = FakeHost::new(issue);
    host.world().cloud = true;
    host.world().issue_body = None;
    host
}

#[test]
fn in_a_cloud_workspace_a_clean_pull_request_stops_at_ready_to_merge_whatever_the_switch_said() {
    // Asked for on, as a desktop that knows no better might: it stays off.
    let run = Run::start_in(cloud_host(&github_issue()), true);
    let started = run.pipeline();
    assert!(started.cloud && !started.auto_merge);
    assert_eq!(run.kinds(), ["started", "note"]);
    assert!(started.events[1].message.contains("stops at Ready to merge"));

    let ready = run.to_gate();
    assert_eq!((ready.stage, ready.state, ready.reason.clone()), (Stage::Merge, State::ReadyToMerge, Some(StopReason::CloudWorkspace)));
    assert_eq!(run.host.world().comments.len(), 1, "the review is posted as on this computer");
    assert!(run.merges().is_empty());
    // Neither the switch nor Merge makes the runtime merge.
    assert!(set_auto_merge(&run.host, &run.id, true).unwrap_err().to_string().contains("never merges by itself"));
    assert!(act(&run.host, &run.id, Action::Merge).unwrap_err().to_string().contains("cloud workspace"));
    assert_eq!(run.poll().state, State::ReadyToMerge);
    assert!(run.merges().is_empty());
    assert!(!run.pipeline().auto_merge);
}

#[test]
fn a_cloud_pipeline_stops_for_the_same_reasons_as_one_on_this_computer() {
    // A failing check on the reviewed commit.
    let host = cloud_host(&github_issue());
    host.world().checks = vec![check("build", "failure")];
    let run = Run::start_in(host, false);
    assert_eq!(run.to_gate().reason, Some(StopReason::ChecksFailed { names: vec!["build".into()] }));
    // One run at a time: each holds the test home.
    drop(run);
    // A head pushed by hand after the review.
    let run = Run::start_in(cloud_host(&github_issue()), false);
    run.to_gate();
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    assert_eq!(run.poll().reason, Some(StopReason::HeadMoved { reviewed: C1.into(), head: C2.into() }));
    drop(run);
    // Findings still open after the last round.
    let host = cloud_host(&github_issue());
    host.world().settings.max_rounds = 1;
    let run = Run::start_in(host, false);
    run.to_review();
    let limited = run.reviewer(&reviewed(C1, "changes", HIGH));
    assert!(matches!(limited.reason, Some(StopReason::RoundLimit { rounds: 1, count: 1, .. })), "{:?}", limited.reason);
}

#[test]
fn a_cloud_workspace_that_may_not_read_the_checks_stops_at_ready_to_merge_saying_so() {
    let run = Run::start_in(cloud_host(&github_issue()), false);
    run.to_review();
    // GitHub refuses the workspace's token the commit's checks.
    {
        let mut world = run.host.world();
        let pr = world.pr.as_mut().unwrap();
        pr.checks.clear();
        pr.checks_unread = true;
    }
    let ready = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!((ready.state, ready.reason), (State::ReadyToMerge, Some(StopReason::ChecksUnreadable { workspace: true })));
    assert!(ready.note.unwrap().contains("your own GitHub sign-in"));
    assert!(run.merges().is_empty());
}

#[test]
fn a_cloud_workspaces_linear_issue_is_moved_to_review_by_a_desktop_and_recorded_once() {
    let run = Run::start_in(cloud_host(&linear_issue()), false);
    // No pull request yet: nothing to have moved it for.
    assert!(note_tracker(&run.host, &run.id, "Moved ENG-42 to In Review in Linear.").unwrap_err().to_string().contains("no pull request"));
    run.to_review();
    // The desktop's line, once; a second desktop saying it again adds nothing.
    let noted = note_tracker(&run.host, &run.id, "Moved ENG-42 to In Review in Linear.").unwrap();
    let tracker: Vec<_> = noted.events.iter().filter(|event| event.kind == "tracker").collect();
    assert_eq!(tracker.len(), 1);
    assert_eq!((tracker[0].message.as_str(), tracker[0].url.as_deref()), ("Moved ENG-42 to In Review in Linear.", Some("https://linear.app/acme/issue/ENG-42")));
    assert_eq!(note_tracker(&run.host, &run.id, "ENG-42 is In Review in Linear and was left there.").unwrap().events.iter().filter(|event| event.kind == "tracker").count(), 1);
    drop(run);
    // Only for a Linear issue in a cloud workspace.
    let run = Run::start_in(cloud_host(&github_issue()), false);
    run.to_review();
    assert!(note_tracker(&run.host, &run.id, "Moved.").unwrap_err().to_string().contains("not a Linear issue"));
}

#[test]
fn a_cloud_reviewer_reads_the_issue_as_the_session_was_started_with_it() {
    let run = Run::start_with(cloud_host(&linear_issue()), None, Some("  Login times out after 30s.\n  "));
    assert_eq!(run.pipeline().issue_body.as_deref(), Some("Login times out after 30s."));
    let reviewing = run.to_review();
    let asked = run.host.prompts_to(&reviewing.reviewer.unwrap().session_id);
    assert!(asked[0].contains("> Login times out after 30s."), "{}", asked[0]);
    drop(run);

    // A very long issue is kept to its start.
    let long = "word ".repeat(10_000);
    let run = Run::start_with(cloud_host(&github_issue()), None, Some(&long));
    let kept = run.pipeline().issue_body.unwrap();
    assert!(kept.len() < long.len() && kept.len() <= 16 * 1024 + 8 && kept.ends_with("[…]"));
}

#[test]
fn a_merge_made_from_the_desktop_is_recorded_as_the_persons_once_the_runtime_reads_it() {
    let run = Run::start_in(cloud_host(&github_issue()), false);
    run.to_gate();
    // The desktop merged it, pinned, with the reader's own gh.
    run.host.world().pr.as_mut().unwrap().state = "MERGED".into();
    let merged = note_merge(&run.host, &run.id, C1).unwrap();
    assert_eq!(merged.state, State::Merged);
    let record = merged.merged.clone().unwrap();
    assert_eq!((record.commit.as_str(), record.by), (C1, MergedBy::Person));
    assert_eq!(merged.events.last().unwrap().message, "Merged from the issue page: pull request #7 at 1111111111 into main.");
    assert!(run.merges().is_empty(), "the runtime merged nothing itself");
    // Said twice, it is still one merge.
    assert_eq!(note_merge(&run.host, &run.id, C1).unwrap().events.len(), merged.events.len());
}

#[test]
fn a_desktop_merge_github_has_only_queued_is_waited_for_and_stays_the_persons() {
    let run = Run::start_in(cloud_host(&github_issue()), false);
    run.to_gate();
    // GitHub took it into a merge queue: the pull request is still open at the reviewed commit.
    let queued = note_merge(&run.host, &run.id, C1).unwrap();
    assert_eq!((queued.state, queued.merge_requested.as_ref().map(|request| request.by)), (State::Waiting, Some(MergedBy::Person)));
    assert_eq!(engine::holding_at(run.host.now()), 1, "waiting on GitHub holds the workspace awake");
    run.host.world().pr.as_mut().unwrap().state = "MERGED".into();
    let merged = run.poll();
    assert_eq!((merged.state, merged.merged.unwrap().by), (State::Merged, MergedBy::Person));
    assert_eq!(engine::holding_at(run.host.now()), 0);
}

#[test]
fn a_pipeline_waiting_on_checks_holds_a_cloud_workspace_awake_until_they_finish() {
    let host = cloud_host(&github_issue());
    host.world().checks = vec![check("build", "in_progress")];
    let run = Run::start_in(host, false);
    let waiting = run.to_gate();
    assert_eq!(waiting.state, State::Waiting);
    assert_eq!(engine::holding_at(run.host.now()), 1);
    run.host.world().pr.as_mut().unwrap().checks = vec![check("build", "success")];
    assert_eq!(run.poll().state, State::ReadyToMerge);
    assert_eq!(engine::holding_at(run.host.now()), 0);
    drop(run);
    // Not for ever: checks that never finish are left to a person, and the workspace may sleep.
    let host = cloud_host(&github_issue());
    host.world().checks = vec![check("build", "queued")];
    let run = Run::start_in(host, false);
    run.to_gate();
    run.host.world().now += TimeDelta::minutes(i64::from(engine::CHECKS_WAIT_MINUTES));
    assert!(matches!(run.poll().reason, Some(StopReason::ChecksStalled { .. })));
    assert_eq!(engine::holding_at(run.host.now()), 0);
}

#[test]
fn a_wait_on_github_holds_a_cloud_workspace_no_longer_than_its_limit_even_when_github_cannot_be_read() {
    let host = cloud_host(&github_issue());
    host.world().checks = vec![check("build", "in_progress")];
    let run = Run::start_in(host, false);
    assert_eq!(run.to_gate().state, State::Waiting);
    // The App was removed from the repository, or GitHub is down: the pull request cannot be read.
    run.host.world().pr = None;
    assert_eq!(run.poll().state, State::Waiting, "a look that fails changes nothing at first");
    assert_eq!(engine::holding_at(run.host.now()), 1);
    // The hold ends with the limit whatever happens to the looks.
    let limit = TimeDelta::minutes(i64::from(engine::CHECKS_WAIT_MINUTES));
    assert_eq!(engine::holding_at(run.host.now() + limit), 0);
    // And the next look after it stops the pipeline for a person, saying why.
    run.host.world().now += limit;
    let stopped = run.poll();
    assert_eq!(stopped.state, State::NeedsYou);
    assert!(matches!(&stopped.reason, Some(StopReason::Failed { step, message }) if step == "Reading the pull request" && message.contains("could not be read")), "{:?}", stopped.reason);
    assert_eq!(engine::holding_at(run.host.now()), 0);
    assert!(run.merges().is_empty());
}

#[test]
fn a_report_whose_step_the_restart_lost_is_taken_when_the_runtime_wakes_and_an_older_one_is_not() {
    // The author reported the work done; the runtime stopped before the step that opens the pull request wrote anything.
    let run = Run::start_in(cloud_host(&github_issue()), false);
    run.host.world().replies.insert("author".into(), (Utc::now() + TimeDelta::minutes(1), done("Pads the minutes.")));
    resume(&run.host, &[]);
    let reviewing = run.pipeline();
    assert_eq!((reviewing.stage, reviewing.state), (Stage::Review, State::Working));
    assert_eq!(run.host.world().pushes, [C1]);
    assert_eq!(run.host.world().created.len(), 1);
    let reviewer = reviewing.reviewer.unwrap().session_id;

    // A reply from before the pipeline last changed was already acted on, or answered by a person: not taken again.
    run.host.world().replies.insert(reviewer.clone(), (Utc::now() - TimeDelta::hours(1), reviewed(C1, "merge", "[]")));
    resume(&run.host, &[]);
    assert_eq!((run.pipeline().stage, run.pipeline().state), (Stage::Review, State::Working));
    // The reviewer's verdict whose step was lost is.
    run.host.world().now += TimeDelta::minutes(4);
    run.host.world().replies.insert(reviewer, (Utc::now() + TimeDelta::minutes(1), reviewed(C1, "merge", "[]")));
    resume(&run.host, &[]);
    let ready = run.pipeline();
    assert_eq!((ready.stage, ready.state, ready.reason), (Stage::Merge, State::ReadyToMerge, Some(StopReason::CloudWorkspace)));
    assert_eq!(run.host.world().created.len(), 1, "one pull request, however often the runtime wakes");
}

#[test]
fn a_stages_work_holds_a_cloud_workspace_awake_and_a_look_at_a_parked_pipeline_does_not() {
    let run = Run::start_in(cloud_host(&github_issue()), false);
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let watch = |seen: &std::sync::Arc<Mutex<Vec<usize>>>| -> Hook {
        let seen = seen.clone();
        Box::new(move || seen.lock().unwrap().push(engine::holding()))
    };
    // Opening the pull request and starting the review: the diff is read mid-step.
    run.host.world().during_diff = Some(watch(&seen));
    run.to_review();
    assert_eq!(run.reviewer(&reviewed(C1, "merge", "[]")).state, State::ReadyToMerge);
    // Parked on a person, the poller looks at it every few minutes for days: that is no reason to stay up.
    run.host.world().during_diff = Some(watch(&seen));
    assert_eq!(run.poll().state, State::ReadyToMerge);
    assert_eq!(*seen.lock().unwrap(), [1, 0]);
    assert_eq!(engine::holding(), 0);
}

#[test]
fn a_cloud_workspace_that_wakes_picks_its_pipelines_up_where_they_were() {
    // Waiting for the author to report: still waiting once the runtime is back.
    let run = Run::start_in(cloud_host(&github_issue()), false);
    resume(&run.host, &[("someone".into(), "else".into())]);
    assert_eq!((run.pipeline().stage, run.pipeline().state), (Stage::Work, State::Working));
    // Unless the restart ended the author's turn: that is said.
    resume(&run.host, &[("author".into(), "t1".into())]);
    let stopped = run.pipeline();
    assert_eq!(stopped.state, State::NeedsYou);
    assert!(matches!(&stopped.reason, Some(StopReason::SessionStopped { role, detail }) if role == "author" && detail.contains("restarted")), "{:?}", stopped.reason);
    // Its next report carries it on, as after any stop for one of its own reasons.
    assert_eq!(run.author(&done("Pads the minutes.")).stage, Stage::Review);

    // The reviewer's turn, likewise.
    let reviewer = run.pipeline().reviewer.unwrap();
    resume(&run.host, &[]);
    assert_eq!((run.pipeline().stage, run.pipeline().state), (Stage::Review, State::Working));
    resume(&run.host, &[(reviewer.session_id.clone(), reviewer.tab_id.clone())]);
    assert!(matches!(run.pipeline().reason, Some(StopReason::SessionStopped { ref role, .. }) if role == "reviewer"));
    drop(run);

    // At the merge stage nothing is said: the poller looks at it again.
    let run = Run::start_in(cloud_host(&github_issue()), false);
    run.to_gate();
    resume(&run.host, &[("author".into(), "t1".into())]);
    assert_eq!(run.pipeline().state, State::ReadyToMerge);
}

#[test]
fn pr_associations_migrate_only_author_evidence_and_outlive_pipeline_history() {
    let run = Run::start(&github_issue(), false);
    let first = run.to_review();
    let reviewer = first.reviewer.as_ref().unwrap();
    assert!(crate::pr_associations::for_session(&reviewer.session_id, vec![]).unwrap().is_empty());
    let saved = crate::pr_associations::for_session("author", vec![]).unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].url, first.pr.as_ref().unwrap().url);

    let mut followup = first.clone();
    followup.id = "followup".into();
    followup.branch = "followup-branch".into();
    followup.pr.as_mut().unwrap().number = 8;
    followup.pr.as_mut().unwrap().url = "https://github.com/acme/widgets/pull/8".into();
    store::insert(&followup).unwrap();
    assert_eq!(crate::pr_associations::for_session("author", vec![]).unwrap().len(), 2);
    // A restart reads the separate file, including after pipeline retention.
    crate::store::write_json(&crate::store::root().unwrap().join("issue-pipelines.json"), &serde_json::json!({"pipelines":[]})).unwrap();
    assert_eq!(crate::pr_associations::for_session("author", vec![]).unwrap().len(), 2);
    assert!(crate::pr_associations::for_session("unrelated", vec![]).unwrap().is_empty());
}

#[test]
fn reviewer_tabs_are_independent_and_reused_after_a_changed_head() {
    let host = FakeHost::new(&github_issue());
    host.world().reviewer_tabs = true;
    let run = Run::start_in(host, false);
    run.to_review();
    let self_review = run.author(&reviewed(C1, "merge", "[]"));
    assert_eq!(self_review.stage, Stage::Review);
    assert!(self_review.verdict.is_none(), "the author cannot certify its own change");
    let ready = run.reviewer(&reviewed(C1, "merge", "[]"));
    let reviewer = ready.reviewer.clone().unwrap();
    assert_eq!(reviewer.session_id, ready.author.session_id);
    assert_ne!(reviewer.tab_id, ready.author.tab_id);
    assert_eq!(run.host.world().sessions.len(), 1);
    assert!(store::reviewer_sessions().unwrap().is_empty(), "the owning session still owns issue work");
    run.host.commit(C2);
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    let again = run.poll();
    assert_eq!((again.stage, again.state, again.round), (Stage::Review, State::Working, 2));
    assert_eq!(again.reviewer, Some(reviewer));
    assert_eq!(again.verdict.as_ref().unwrap().commit, C1, "retain findings until a fresh verdict");
    assert_eq!(run.host.world().reviewers, 1);
    assert!(run.merges().is_empty());
    assert_eq!(run.reviewer(&reviewed(C2, "merge", "[]")).state, State::ReadyToMerge);
}

#[test]
fn automatic_head_review_waits_for_idle_clean_current_checkout_and_respects_limits() {
    for obstacle in ["active", "waiting", "dirty", "stale", "stopped", "limit"] {
        let run = Run::start(&github_issue(), false);
        run.to_gate();
        run.host.commit(C2);
        run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
        match obstacle {
            "active" => run.host.world().sessions.get_mut("author").unwrap().tabs[0].status = crate::store::index::TabStatus::InProgress,
            "waiting" => run.host.world().sessions.get_mut("author").unwrap().tabs[0].status = crate::store::index::TabStatus::Waiting,
            "dirty" => run.host.world().workspace.dirty.push("work.rs".into()),
            "stale" => run.host.commit(C1),
            "stopped" => { act(&run.host, &run.id, Action::Stop).unwrap(); }
            "limit" => { let mut p = run.pipeline(); p.max_rounds = p.round; store::commit(&mut p).unwrap(); }
            _ => unreachable!(),
        }
        let parked = run.poll();
        assert_ne!(parked.stage, Stage::Review, "{obstacle}");
        assert_eq!(parked.round, 1, "{obstacle}");
        assert!(run.merges().is_empty());
    }
}

#[test]
fn agent_merge_uses_the_gate_without_person_authority() {
    for hold in ["none", "person", "protected", "security", "ci", "workflow", "unread", "findings", "stale", "unpublished", "dirty", "stopped", "cloud"] {
        let run = Run::start(&github_issue(), false);
        run.to_gate();
        match hold {
            "person" => run.host.world().settings.require_person = true,
            "protected" => run.host.world().diff.paths = vec![".github/workflows/ci.yml".into()],
            "security" => { let mut p = run.pipeline(); p.security_areas = vec!["authorization".into()]; store::commit(&mut p).unwrap(); }
            "ci" => run.host.world().pr.as_mut().unwrap().checks = vec![check("build", "failure")],
            "workflow" => run.host.world().pr.as_mut().unwrap().validation = Some(vec![check("rerun", "pending")]),
            "unread" => run.host.world().pr.as_mut().unwrap().checks_unread = true,
            "findings" => { let mut p = run.pipeline(); p.verdict.as_mut().unwrap().decision = super::verdict::Decision::Changes; store::commit(&mut p).unwrap(); }
            "unpublished" => run.host.commit(C2),
            "dirty" => run.host.world().workspace.dirty.push("work.rs".into()),
            "stale" => run.host.world().pr.as_mut().unwrap().head_sha = C2.into(),
            "stopped" => { act(&run.host, &run.id, Action::Stop).unwrap(); }
            "cloud" => { let mut p = run.pipeline(); p.cloud = true; store::commit(&mut p).unwrap(); }
            _ => {}
        }
        let result = engine::act_from_agent(&run.host, &run.id, Action::Merge);
        if hold == "none" {
            assert_eq!(result.unwrap().merged.unwrap().by, MergedBy::Pipeline);
            assert_eq!(run.merges(), [("merge".into(), C1.into())]);
        } else {
            assert!(run.merges().is_empty(), "{hold}");
        }
    }
}

#[test]
fn failed_local_checks_cannot_be_advanced_to_merge_by_an_agent() {
    let run = Run::start(&github_issue(), false);
    run.author("```terminalx-status\n{\"status\":\"done\",\"checks\":\"failed\"}\n```");
    assert!(engine::act_from_agent(&run.host, &run.id, Action::Merge).is_err());
    assert!(run.merges().is_empty());
}

#[test]
fn legacy_separate_reviewer_is_reused_without_migrating_history() {
    let run = Run::start(&github_issue(), false);
    let ready = run.to_gate();
    let reviewer = ready.reviewer.clone().unwrap();
    assert_ne!(reviewer.session_id, ready.author.session_id);
    assert!(store::reviewer_sessions().unwrap().contains(&reviewer.session_id));
    run.host.commit(C2);
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    let next = run.poll();
    assert_eq!(next.reviewer, Some(reviewer));
    assert_eq!(next.round, 2);
    assert_eq!(run.host.world().sessions.len(), 2);
    assert_eq!(run.host.world().reviewers, 1);
}

#[test]
fn stop_during_head_review_preparation_sends_no_review() {
    let run = Run::start(&github_issue(), false);
    run.to_gate();
    run.host.commit(C2);
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    let id = run.id.clone();
    run.host.world().during_diff = Some(Box::new(move || { store::set_switches(&id, |p| p.stopped = true).unwrap(); }));
    let stopped = run.poll();
    assert_eq!(stopped.state, State::Stopped);
    assert_eq!(stopped.round, 1);
    assert!(run.merges().is_empty());
}

#[test]
fn a_missing_reviewer_can_be_replaced_when_the_head_moves() {
    let host = FakeHost::new(&github_issue());
    host.world().reviewer_tabs = true;
    let run = Run::start_in(host, false);
    let old = run.to_gate().reviewer.unwrap();
    run.host.world().sessions.get_mut("author").unwrap().tabs.retain(|tab| tab.id != old.tab_id);
    run.host.commit(C2);
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    let again = run.poll();
    assert_eq!(again.stage, Stage::Review);
    assert_ne!(again.reviewer.as_ref(), Some(&old));
    assert_eq!(again.reviewer.unwrap().session_id, "author");
    assert_eq!(run.host.world().sessions.len(), 1);
}


#[test]
fn a_changed_heads_failed_local_checks_survive_polling_and_require_a_pass_for_that_head() {
    for status in ["done", "blocked"] {
        let run = Run::start(&github_issue(), false);
        run.to_gate();
        run.host.commit(C2);
        run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
        let failed = run.author(&format!("```terminalx-status\n{{\"status\":\"{status}\",\"checks\":\"failed\"}}\n```"));
        assert_eq!(failed.reason, Some(StopReason::LocalChecksFailed));
        assert_eq!(store::get(&run.id).unwrap().failed_local_checks, [C2]);
        assert_eq!(run.poll().reason, Some(StopReason::LocalChecksFailed));
        assert_eq!(act(&run.host, &run.id, Action::Review).unwrap().reason, Some(StopReason::LocalChecksFailed));
        assert_eq!(run.pipeline().round, 1);
        assert!(engine::act_from_agent(&run.host, &run.id, Action::Merge).is_err());
        // A different head's passing report cannot clear the failed commit.
        run.host.commit(C3);
        run.author(&done("Checks pass on a different commit."));
        run.host.commit(C2);
        assert_eq!(run.poll().reason, Some(StopReason::LocalChecksFailed));
        run.author("```terminalx-status\n{\"status\":\"done\",\"checks\":\"none\"}\n```");
        assert_eq!(run.pipeline().failed_local_checks, [C2]);
        run.host.world().workspace.dirty.push("uncommitted-fix.rs".into());
        run.author(&done("Only the uncommitted tree passes."));
        assert_eq!(run.pipeline().failed_local_checks, [C2]);
        run.host.world().workspace.dirty.clear();
        let reviewing = run.author(&done("The failing check now passes on this commit."));
        assert_eq!((reviewing.stage, reviewing.round), (Stage::Review, 2));
        assert!(reviewing.failed_local_checks.is_empty());
        run.reviewer(&reviewed(C2, "merge", "[]"));
        assert_eq!(engine::act_from_agent(&run.host, &run.id, Action::Merge).unwrap().state, State::Merged);
    }
}

#[test]
fn a_clean_verdict_cannot_override_a_local_failure_reported_during_review() {
    let run = Run::start(&github_issue(), false);
    run.to_gate();
    run.host.commit(C2);
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    assert_eq!(run.poll().stage, Stage::Review);
    run.author("```terminalx-status\n{\"status\":\"done\",\"checks\":\"failed\"}\n```");
    assert_eq!(run.reviewer(&reviewed(C2, "merge", "[]")).reason, Some(StopReason::LocalChecksFailed));
    assert!(set_auto_merge(&run.host, &run.id, true).unwrap().merged.is_none());
    // Even a stale Ready state cannot let either caller bypass the stored failure.
    for person in [false, true] {
        let mut stale = run.pipeline();
        stale.state = State::ReadyToMerge;
        store::commit(&mut stale).unwrap();
        let blocked = if person { act(&run.host, &run.id, Action::Merge) } else { engine::act_from_agent(&run.host, &run.id, Action::Merge) }.unwrap();
        assert_eq!(blocked.reason, Some(StopReason::LocalChecksFailed));
    }
    assert!(run.merges().is_empty());
}

#[test]
fn conflict_resolution_waits_for_author_then_reviews_and_checks_the_new_head() {
    let run = Run::start(&github_issue(), true);
    run.to_review();
    set_resolve_conflicts(&run.host, &run.id, true).unwrap();
    {
        let mut world = run.host.world();
        world.conflict = true;
        world.pr.as_mut().unwrap().merge_state = "DIRTY".into();
        world.sessions.get_mut("author").unwrap().tabs[0].status = crate::store::index::TabStatus::InProgress;
    }
    assert_eq!(run.poll().stage, Stage::Review);
    assert!(run.host.prompts_to("resolver").is_empty());
    run.host.world().sessions.get_mut("author").unwrap().tabs[0].status = crate::store::index::TabStatus::Completed;
    assert_eq!(run.poll().stage, Stage::Resolve);
    assert_eq!(run.host.prompts_to("resolver").len(), 1);
    run.host.commit(C2);
    {
        let mut world = run.host.world();
        world.conflict = false;
        world.pr.as_mut().unwrap().merge_state = "CLEAN".into();
        world.checks = vec![check("build", "pending")];
    }
    turn_completed(&run.host, "resolver", "t1", Some(&done("Merged the base.")));
    assert_eq!(run.pipeline().stage, Stage::Review);
    assert_eq!(run.pipeline().review_commit.as_deref(), Some(C2));
    assert!(run.pipeline().resolution.is_none());
    assert_eq!(run.reviewer(&reviewed(C2, "merge", "[]")).state, State::Waiting);
    assert!(run.merges().is_empty());
    run.host.world().pr.as_mut().unwrap().checks = vec![check("build", "success")];
    assert_eq!(run.poll().state, State::Merged);
    assert_eq!(run.merges()[0].1, C2);
}

#[test]
fn a_resolution_limit_dirty_checkout_and_remote_writer_stop_without_push() {
    for stop in ["limit", "dirty", "writer", "failed"] {
        let run = Run::start(&github_issue(), false);
        run.to_review();
        set_resolve_conflicts(&run.host, &run.id, true).unwrap();
        {
            let mut world = run.host.world();
            world.conflict = true;
            world.pr.as_mut().unwrap().merge_state = "DIRTY".into();
            if stop == "limit" { world.settings.max_resolutions = 1; }
            if stop == "dirty" { world.workspace.dirty.push("work.txt".into()); }
        }
        if stop == "limit" {
            let mut pipeline = run.pipeline();
            pipeline.resolutions = 1;
            store::commit(&mut pipeline).unwrap();
        }
        let state = run.poll();
        if matches!(stop, "writer" | "failed") {
            assert_eq!(state.stage, Stage::Resolve);
            run.host.commit(C2);
            if stop == "writer" { run.host.world().pr.as_mut().unwrap().head_sha = "someone-else".into(); }
            let report = if stop == "failed" { "```terminalx-status\n{\"status\":\"blocked\",\"checks\":\"failed\",\"reason\":\"Intent is ambiguous\"}\n```".into() } else { done("Resolved") };
            turn_completed(&run.host, "resolver", "t1", Some(&report));
        }
        assert_eq!(run.pipeline().state, State::NeedsYou, "{stop}");
        assert_eq!(run.host.world().pushes, [C1], "{stop}");
        assert!(run.merges().is_empty());
    }
}

#[test]
fn conflicts_are_watched_before_a_pull_request_exists() {
    let run = Run::start(&github_issue(), false);
    set_resolve_conflicts(&run.host, &run.id, true).unwrap();
    run.host.world().conflict = true;
    assert_eq!(run.poll().stage, Stage::Resolve);
    assert!(run.pipeline().pr.is_none());
    run.host.commit(C2);
    turn_completed(&run.host, "resolver", "t1", Some(&done("Resolved")));
    assert_eq!(run.pipeline().stage, Stage::Work);
    assert!(run.pipeline().pr.is_none());
}

#[test]
fn local_checks_are_run_by_terminalx_again_for_each_head_and_policy_change() {
    let run = Run::start(&github_issue(), false);
    run.host.world().settings.local_check_command = Some("project-check".into());
    assert_eq!(run.to_gate().state, State::ReadyToMerge);
    assert_eq!(run.host.world().local_runs, [(C1.into(), "project-check".into())]);
    run.poll();
    assert_eq!(run.host.world().local_runs.len(), 1);
    run.host.world().settings.local_check_command = Some("new-project-check".into());
    run.poll();
    assert_eq!(run.host.world().local_runs.len(), 2);
    run.host.commit(C2);
    run.host.world().pr.as_mut().unwrap().head_sha = C2.into();
    run.poll();
    assert_eq!(run.pipeline().stage, Stage::Review);
    run.reviewer(&reviewed(C2, "merge", "[]"));
    assert_eq!(run.host.world().local_runs.last(), Some(&(C2.into(), "new-project-check".into())));
}

#[test]
fn failed_local_command_does_not_merge_even_with_successful_hosted_checks() {
    let run = Run::start(&github_issue(), true);
    run.host.world().settings.local_check_command = Some("project-check".into());
    run.host.world().local_error = true;
    assert_eq!(run.to_gate().state, State::NeedsYou);
    assert!(!run.pipeline().checking_locally);
    assert!(run.pipeline().local_check.is_none());
    assert!(run.merges().is_empty());
}

#[test]
fn local_checks_wait_for_an_active_author_then_resume_on_the_next_poll() {
    let run = Run::start(&github_issue(), false);
    run.host.world().settings.local_check_command = Some("project-check".into());
    run.to_review();
    run.host.world().sessions.get_mut("author").unwrap().tabs[0].status = crate::store::index::TabStatus::InProgress;
    let waiting = run.reviewer(&reviewed(C1, "merge", "[]"));
    assert_eq!((waiting.stage, waiting.state), (Stage::Merge, State::Waiting));
    assert!(run.host.world().local_runs.is_empty());
    run.host.world().sessions.get_mut("author").unwrap().tabs[0].status = crate::store::index::TabStatus::Completed;
    assert_eq!(run.poll().state, State::ReadyToMerge);
    assert_eq!(run.host.world().local_runs.len(), 1);
}

#[test]
fn a_resolver_never_runs_beside_a_reviewer_or_discards_its_security_findings() {
    let run = Run::start(&github_issue(), false);
    run.to_review();
    set_resolve_conflicts(&run.host, &run.id, true).unwrap();
    let reviewer = run.pipeline().reviewer.unwrap();
    {
        let mut world = run.host.world();
        world.conflict = true;
        world.pr.as_mut().unwrap().merge_state = "DIRTY".into();
        world.sessions.get_mut(&reviewer.session_id).unwrap().tabs[0].status = crate::store::index::TabStatus::InProgress;
    }
    assert_eq!(run.poll().stage, Stage::Review);
    assert!(run.host.prompts_to("resolver").is_empty());
    run.host.world().sessions.get_mut(&reviewer.session_id).unwrap().tabs[0].status = crate::store::index::TabStatus::Completed;
    let findings = r#"[{"severity":"high","title":"Authorization bypass","security":true}]"#;
    run.reviewer(&reviewed_with(C1, "changes", findings, "flagged"));
    let verdict = run.pipeline().verdict;
    run.poll();
    assert_eq!(run.pipeline().stage, Stage::Resolve);
    assert_eq!(run.pipeline().verdict, verdict);
    run.host.commit(C2);
    run.host.world().conflict = false;
    run.host.world().pr.as_mut().unwrap().merge_state = "CLEAN".into();
    turn_completed(&run.host, "resolver", "t1", Some(&done("Merged the base")));
    assert_eq!(run.pipeline().stage, Stage::Review);
    assert_eq!(run.pipeline().verdict, verdict);
    assert!(run.merges().is_empty());
}

#[test]
fn an_author_handoff_requires_an_idle_resumed_pipeline_and_preserves_review_evidence() {
    let run = Run::start(&github_issue(), false);
    let reviewed = run.to_gate().verdict;
    {
        let mut world = run.host.world();
        let author = world.sessions.get_mut("author").unwrap();
        let mut tab = author.tabs[0].clone();
        tab.id = "continuation".into();
        author.tabs.push(tab);
        author.tabs[0].status = crate::store::index::TabStatus::InProgress;
    }
    assert!(start(&run.host, "author", "continuation", Some(false), None).is_err());
    assert_eq!(run.pipeline().author.tab_id, "t1");
    run.host.world().sessions.get_mut("author").unwrap().tabs[0].status = crate::store::index::TabStatus::Completed;
    act(&run.host, &run.id, Action::Stop).unwrap();
    assert!(start(&run.host, "author", "continuation", Some(false), None).unwrap_err().to_string().contains("Resume"));
    store::set_switches(&run.id, |pipeline| { pipeline.stopped = false; }).unwrap();
    let continued = start(&run.host, "author", "continuation", Some(false), None).unwrap();
    assert_eq!(continued.author.tab_id, "continuation");
    assert_eq!(continued.stage, Stage::Work);
    assert_eq!(continued.verdict, reviewed);
    assert_eq!(run.host.world().sessions.get("author").unwrap().tabs[0].id, "t1");
}

#[test]
fn a_continuation_persists_its_explicit_merge_choice_without_merging() {
    for (before, choice, cloud, expected) in [(true, false, false, false), (false, true, false, true), (false, true, true, false)] {
        let run = Run::start(&github_issue(), before);
        set_resolve_conflicts(&run.host, &run.id, true).unwrap();
        let mut pipeline = run.pipeline();
        pipeline.cloud = cloud;
        store::commit(&mut pipeline).unwrap();
        {
            let mut world = run.host.world();
            let author = world.sessions.get_mut("author").unwrap();
            let mut tab = author.tabs[0].clone();
            tab.id = "continuation".into();
            author.tabs.push(tab);
        }
        let continued = start(&run.host, "author", "continuation", Some(choice), None).unwrap();
        assert_eq!(continued.auto_merge, expected);
        assert_eq!(run.pipeline().auto_merge, expected);
        assert!(continued.resolve_conflicts);
        assert_eq!(continued.author.tab_id, "continuation");
        assert!(run.merges().is_empty());
    }
}

#[test]
fn resolver_termination_releases_a_stopped_pipelines_checkout() {
    for interrupted in [true, false] {
        let run = Run::start(&github_issue(), false);
        set_resolve_conflicts(&run.host, &run.id, true).unwrap();
        run.host.world().conflict = true;
        assert_eq!(run.poll().stage, Stage::Resolve);
        act(&run.host, &run.id, Action::Stop).unwrap();
        assert!(run.pipeline().resolution.is_some(), "Stop cannot release a still-running resolver");
        turn_failed(&run.host, "resolver", "t1", engine::turn_failure(interrupted));
        let stopped = run.pipeline();
        assert!(stopped.stopped);
        assert_eq!(stopped.state, State::Stopped);
        assert!(stopped.resolution.is_none());
        assert!(stopped.events.iter().any(|event| event.kind == "resolutionStopped"));
        assert!(super::admission::check("author", "t1").is_ok());
        assert!(run.merges().is_empty());
        assert!(run.host.world().pushes.is_empty());
    }
}

#[test]
fn all_off_continuation_revokes_both_permissions_and_hands_over_the_existing_pipeline() {
    let run = Run::start(&github_issue(), true);
    set_resolve_conflicts(&run.host, &run.id, true).unwrap();
    {
        let mut world = run.host.world();
        let author = world.sessions.get_mut("author").unwrap();
        let mut tab = author.tabs[0].clone();
        tab.id = "continuation".into();
        author.tabs.push(tab);
    }
    let continued = engine::continue_launch(&run.host, "author", "continuation", &super::LaunchOptions::default()).unwrap().unwrap();
    assert_eq!(continued.id, run.id);
    assert_eq!(continued.author.tab_id, "continuation");
    assert!(!continued.auto_merge && !continued.resolve_conflicts);
    assert!(!run.pipeline().auto_merge && !run.pipeline().resolve_conflicts);
    assert_eq!(store::list().unwrap().len(), 1);
    assert!(run.merges().is_empty());
    // Retry on the already-created destination must apply revocations too.
    store::set_switches(&run.id, |pipeline| { pipeline.auto_merge = true; pipeline.resolve_conflicts = true; }).unwrap();
    engine::continue_launch(&run.host, "author", "continuation", &super::LaunchOptions::default()).unwrap();
    assert!(!run.pipeline().auto_merge && !run.pipeline().resolve_conflicts);
}

#[test]
fn all_off_continuation_does_not_create_a_pipeline_and_read_errors_are_not_absence() {
    let _home = crate::store::temp_home();
    let host = FakeHost::new(&github_issue());
    assert!(engine::continue_launch(&host, "author", "t1", &super::LaunchOptions::default()).unwrap().is_none());
    assert!(store::list().unwrap().is_empty());
    std::fs::write(crate::store::root().unwrap().join("issue-pipelines.json"), "not valid JSON").unwrap();
    assert!(engine::continue_launch(&host, "author", "t1", &super::LaunchOptions::default()).is_err());
}

#[test]
fn all_off_continuation_preserves_a_merged_pipeline_even_after_workspace_cleanup() {
    for cleaned in [false, true] {
        let run = Run::start(&github_issue(), true);
        set_resolve_conflicts(&run.host, &run.id, true).unwrap();
        let completed = run.to_gate();
        assert_eq!(completed.state, State::Merged);
        assert!(completed.auto_merge && completed.resolve_conflicts);
        let (announced, sent, pushes, merges) = {
            let mut world = run.host.world();
            let author = world.sessions.get_mut("author").unwrap();
            if cleaned {
                crate::store::index::mark_workspace_removed(author, Some("main".into()));
                assert_eq!(author.cwd, author.project_path);
                assert!(author.worktree_removed);
            }
            let mut tab = author.tabs[0].clone();
            tab.id = "continuation".into();
            author.tabs.push(tab);
            (world.announced, world.sent.clone(), world.pushes.clone(), world.merges.clone())
        };
        assert!(engine::continue_launch(&run.host, "author", "continuation", &super::LaunchOptions::default()).unwrap().is_none());
        assert_eq!(run.pipeline(), completed, "Completed author, permissions, review and history must stay unchanged");
        assert_eq!(store::list().unwrap().len(), 1);
        let world = run.host.world();
        assert_eq!(world.announced, announced);
        assert_eq!(world.sent, sent);
        assert_eq!(world.pushes, pushes);
        assert_eq!(world.merges, merges);
    }
}

#[test]
fn refused_continuation_still_revokes_explicit_off_permissions() {
    for stopped in [false, true] {
        let run = Run::start(&github_issue(), true);
        set_resolve_conflicts(&run.host, &run.id, true).unwrap();
        {
            let mut world = run.host.world();
            let author = world.sessions.get_mut("author").unwrap();
            let mut tab = author.tabs[0].clone();
            tab.id = "continuation".into();
            author.tabs.push(tab);
            author.tabs[0].status = crate::store::index::TabStatus::InProgress;
        }
        if stopped { act(&run.host, &run.id, Action::Stop).unwrap(); }
        assert!(engine::continue_launch(&run.host, "author", "continuation", &super::LaunchOptions::default()).is_err());
        assert_eq!(run.pipeline().author.tab_id, "t1");
        assert!(!run.pipeline().auto_merge && !run.pipeline().resolve_conflicts);
        assert!(run.merges().is_empty());
    }
}
