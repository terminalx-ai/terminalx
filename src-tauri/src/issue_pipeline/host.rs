//! The pipeline's hands where the workspace is: real sessions, `git` and
//! `gh`, and the event the issue page listens for. On this computer they are
//! the reader's own; in a cloud workspace's runtime, git and `gh` run on the
//! token the workspace is given (`cloud_github`).

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};

use crate::github::{PinnedMerge, PrSnapshot};
use crate::issues::LinearReviewMove;
use crate::session::SessionManager;
use crate::session_ops::NewTab;
use crate::sink::EventSink;
use crate::store::index::{self, IssueRef, SessionEntry};
use crate::store::projects::IssuePipelineSettings;

use super::engine::{Diff, Host, Workspace};
use super::{Pipeline, SessionRef};

/// The event a written pipeline is announced with: to the window on the
/// desktop, to attached desktops (`pipeline.changed`) from a cloud workspace.
pub const CHANGED: &str = "issue_pipeline";

/// A diff past this is read for its paths only; the areas a change touches
/// are found in the paths long before a patch gets this large.
const PATCH_LIMIT: usize = 4 * 1024 * 1024;

/// Told the tab id of a session the pipeline opened, so the cloud
/// workspace's agent tabs (and the desktops reading them) know it.
pub type TabAdded = Arc<dyn Fn(&str) + Send + Sync>;

/// Where the sessions and checkouts are.
#[derive(Clone)]
pub enum Place {
    /// This computer: the reader's own `git`, `gh` and Linear key.
    Desktop,
    /// A cloud workspace, from its runtime. Nothing is merged from here, and
    /// there is no Linear key: the desktop's stays on the desktop.
    CloudWorkspace { tab_added: TabAdded },
}

/// The host for the workspaces of one machine. It needs only what the
/// control socket also holds, so the window and the `terminalx` CLI drive the
/// same one, and a cloud workspace's runtime builds it the same way.
#[derive(Clone)]
pub struct LocalHost {
    sink: Arc<dyn EventSink>,
    manager: SessionManager,
    place: Place,
}

impl LocalHost {
    pub fn new(sink: Arc<dyn EventSink>, manager: SessionManager) -> Self {
        Self { sink, manager, place: Place::Desktop }
    }

    /// The host of a cloud workspace's runtime.
    pub fn cloud_workspace(sink: Arc<dyn EventSink>, manager: SessionManager, tab_added: TabAdded) -> Self {
        Self { sink, manager, place: Place::CloudWorkspace { tab_added } }
    }
}

fn issue_number(issue: &IssueRef) -> String {
    issue.identifier.trim_start_matches('#').to_string()
}

fn linear_key() -> Result<String> {
    crate::store::settings::load().linear_api_key.filter(|key| !key.trim().is_empty()).ok_or_else(|| anyhow!("Linear is not connected. Add an API key in Settings → Integrations."))
}

/// What moving a Linear issue to its team's review state did, as the record says it.
pub fn review_move_line(identifier: &str, moved: LinearReviewMove) -> String {
    match moved {
        LinearReviewMove::Moved(state) => format!("Moved {identifier} to {state} in Linear."),
        LinearReviewMove::Unchanged(state) => format!("{identifier} is {state} in Linear and was left there."),
        LinearReviewMove::NoReviewState => format!("{identifier} was left where it is: its Linear team has no review state."),
    }
}

/// The number at the end of a pull request URL.
pub(crate) fn pr_number(url: &str) -> Option<u64> {
    let mut parts = url.trim().trim_end_matches('/').rsplit('/');
    let number = parts.next()?.parse().ok()?;
    (parts.next()? == "pull").then_some(number)
}

/// A transcript's last finished turn: when it ended, and its reply (the
/// turn's final text, else its last message). A subagent's turns are not the tab's.
fn last_reply(events: &[crate::events::AgentEvent]) -> Option<(DateTime<Utc>, String)> {
    use crate::events::{Payload, TurnStatus};
    let end = events.iter().rposition(|event| event.subagent.is_none() && matches!(event.payload, Payload::TurnCompleted { status: TurnStatus::Ok, .. }))?;
    let at = DateTime::parse_from_rfc3339(&events[end].ts).ok()?.with_timezone(&Utc);
    let said = |event: &crate::events::AgentEvent| match &event.payload {
        Payload::AssistantText { text, .. } if event.subagent.is_none() && !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    };
    let reply = match &events[end].payload {
        Payload::TurnCompleted { final_text: Some(text), .. } if !text.trim().is_empty() => text.clone(),
        _ => events[..end].iter().rev().take_while(|event| !matches!(event.payload, Payload::TurnStarted { .. })).find_map(said)?,
    };
    Some((at, reply))
}

/// A checkout as git reports it now.
fn workspace(cwd: &Path) -> Result<Workspace> {
    if !crate::git::is_repo(cwd) {
        bail!("{} is not a Git checkout.", cwd.display());
    }
    let status = crate::git::work_status(cwd);
    let porcelain = crate::git::run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"])?;
    Ok(Workspace {
        head: status.head.context("the checkout has no commit yet")?,
        branch: status.branch,
        default_branch: status.default_branch,
        // `XY path`: two status letters, a space, the path.
        dirty: porcelain.lines().filter_map(|line| line.get(3..)).map(String::from).collect(),
        ahead_of_base: status.ahead_of_base.unwrap_or(0),
    })
}

/// The base branch as this checkout can name it: the remote's, when it has
/// been fetched, since that is what the pull request merges into.
fn base_ref(cwd: &Path, base_branch: &str) -> String {
    let remote = format!("origin/{base_branch}");
    crate::git::resolve_base(cwd, Some(&remote)).unwrap_or_else(|_| base_branch.to_string())
}

/// What `head` changed since it left `base`: the three-dot range, so commits
/// the base gained meanwhile are not counted as the branch's.
fn diff(cwd: &Path, base: &str, head: &str) -> Result<Diff> {
    let range = format!("{base}...{head}");
    // Without rename detection: a file moved out of a protected place is
    // listed where it was as well as where it went.
    let names = crate::git::run(cwd, &["-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", &range, "--"])?;
    let mut patch = crate::git::run(cwd, &["diff", "--no-color", "--no-ext-diff", &range, "--"])?;
    if patch.len() > PATCH_LIMIT {
        patch.clear();
    }
    Ok(Diff { paths: names.lines().filter(|line| !line.is_empty()).map(String::from).collect(), patch })
}

/// How long a push may take before it is given up on.
const PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Push the checkout's branch, setting its upstream the first time. Never
/// forced, and with a deadline: a push that hangs must not hold the pipeline.
fn push(cwd: &Path) -> Result<()> {
    let branch = crate::git::current_branch(cwd).context("the checkout is not on a branch")?;
    let has_upstream = crate::git::run(cwd, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_ok();
    let args: Vec<&str> = if has_upstream { vec!["push"] } else { vec!["push", "-u", "origin", &branch] };
    crate::git::run_within(cwd, &args, PUSH_TIMEOUT, &|| false).map_err(|error| match error {
        crate::git::RunError::TimedOut => anyhow!("git push did not finish within {} minutes.", PUSH_TIMEOUT.as_secs() / 60),
        crate::git::RunError::Stopped => anyhow!("git push was stopped."),
        crate::git::RunError::Failed(message) => anyhow!("{message}"),
        crate::git::RunError::Spawn(error) => anyhow!("git could not be started: {error}"),
    })
}

fn verify_resolution(cwd: &Path, resolution: &super::Resolution, head: &str, branch: &str) -> Result<()> {
        // Exactly one merge, with the two pinned inputs. An extra author or
        // human commit changes the parents and is never silently pushed.
        let parents = crate::git::run(cwd, &["show", "-s", "--format=%P", head, "--"])?;
        if parents.split_whitespace().collect::<Vec<_>>() != [resolution.head.as_str(), resolution.base_commit.as_str()] {
            bail!("The checkout changed during resolution, or the result is not one merge of the pinned inputs. Review the commits manually.");
        }
        if remote_head(cwd, branch)? != resolution.remote_head {
            bail!("Someone pushed to this branch during conflict resolution. Nothing was pushed; reconcile the new remote head manually.");
        }
        Ok(())
}

fn remote_head(cwd: &Path, branch: &str) -> Result<Option<String>> {
    let reference = format!("refs/heads/{branch}");
    let mut command = std::process::Command::new("git");
    command.args(["ls-remote", "--heads", "origin", &reference]).current_dir(cwd);
    let output = crate::git::output_within(command, std::time::Duration::from_secs(30)).map_err(|error| anyhow!("Reading the remote branch failed: {error:?}"))?;
    Ok(output.lines().find_map(|line| {
        let (sha, name) = line.split_once('\t')?;
        (name == reference).then(|| sha.to_string())
    }))
}

fn resolution_needed(cwd: &Path, branch: &str, base: &str, behind: bool) -> Result<Option<super::Resolution>> {
    crate::git::run_within(cwd, &["fetch", "--no-tags", "origin"], PUSH_TIMEOUT, &|| false).map_err(|error| anyhow!("Fetching the base failed: {error:?}"))?;
    let base_ref = format!("refs/remotes/origin/{base}");
    let base_commit = crate::git::run(cwd, &["rev-parse", "--verify", &base_ref])?.trim().to_string();
    let head = crate::git::run(cwd, &["rev-parse", "HEAD"])?.trim().to_string();
    let ahead = crate::git::run(cwd, &["rev-list", "--count", &format!("{base_commit}..{head}")])?;
    let behind_count = crate::git::run(cwd, &["rev-list", "--count", &format!("{head}..{base_commit}")])?;
    if ahead.trim() == "0" || behind_count.trim() == "0" { return Ok(None); }
    // merge-tree computes conflicts without changing the index or checkout.
    let output = std::process::Command::new("git").args(["merge-tree", "--write-tree", &head, &base_commit]).current_dir(cwd).output()?;
    let conflicting = match output.status.code() {
        Some(0) => false,
        Some(1) => true,
        _ => bail!("Could not compare the branch with its base: {}", String::from_utf8_lossy(&output.stderr)),
    };
    if !conflicting && !behind { return Ok(None); }
    Ok(Some(super::Resolution { head, remote_head: remote_head(cwd, branch)?, base: base.to_string(), base_commit, return_stage: super::Stage::Work }))
}

impl Host for LocalHost {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }

    fn cloud(&self) -> bool {
        matches!(self.place, Place::CloudWorkspace { .. })
    }

    fn session(&self, session_id: &str) -> Result<SessionEntry> {
        index::get(session_id)
    }

    fn settings(&self, project_path: &str) -> Result<IssuePipelineSettings> {
        crate::store::projects::issue_pipeline_settings(project_path)
    }

    fn pause(&self) {
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    fn send(&self, to: &SessionRef, prompt: &str) -> Result<()> {
        self.manager.send(&to.session_id, &to.tab_id, prompt.to_string(), Vec::new())?;
        Ok(())
    }

    fn last_reply(&self, session: &SessionRef) -> Option<(DateTime<Utc>, String)> {
        last_reply(&self.manager.load_events(&session.session_id, &session.tab_id).ok()?)
    }

    /// An independent conversation in the owning session, with no fork or
    /// transcript copied from the author. Existing reviewer references are
    /// reused by the engine, including legacy separate sessions.
    fn open_reviewer(&self, pipeline: &Pipeline, author: &SessionEntry) -> Result<SessionRef> {
        let tab = author.tab(&pipeline.author.tab_id).context("the author's conversation is gone")?;
        let reviewer = self.manager.add_tab(&author.id, &NewTab {
            harness: tab.harness.clone(), model: tab.model.clone(), effort: tab.effort.clone(), permission_mode: Some(tab.permission_mode.clone()),
        })?;
        crate::session_ops::rename_tab_entry(&author.id, &reviewer.id, Some("Reviewer".into())).map_err(anyhow::Error::msg)?;
        self.sink.emit("session_updated", &index::get(&author.id)?);
        if let Place::CloudWorkspace { tab_added } = &self.place {
            tab_added(&reviewer.id);
        }
        Ok(SessionRef { session_id: author.id.clone(), tab_id: reviewer.id })
    }

    fn workspace_idle(&self, _pipeline: &Pipeline, cwd: &Path) -> Result<bool> {
        let cwd = cwd.canonicalize()?;
        for session in index::load()? {
            if Path::new(&session.cwd).canonicalize().ok().as_ref() != Some(&cwd) { continue; }
            for tab in &session.tabs {
                if !matches!(tab.status, index::TabStatus::Idle | index::TabStatus::Completed)
                    || !self.manager.pipeline_idle(&session.id, &tab.id) { return Ok(false); }
            }
        }
        Ok(true)
    }

    fn resolution_needed(&self, cwd: &Path, branch: &str, base: &str, behind: bool) -> Result<Option<super::Resolution>> {
        resolution_needed(cwd, branch, base, behind)
    }

    fn open_resolver(&self, pipeline: &Pipeline, author: &SessionEntry) -> Result<SessionRef> {
        let resolver = self.open_reviewer(pipeline, author)?;
        crate::session_ops::rename_tab_entry(&author.id, &resolver.tab_id, Some("Conflict resolver".into())).map_err(anyhow::Error::msg)?;
        self.sink.emit("session_updated", &index::get(&author.id)?);
        Ok(resolver)
    }

    fn verify_resolution(&self, cwd: &Path, resolution: &super::Resolution, head: &str, branch: &str) -> Result<()> {
        verify_resolution(cwd, resolution, head, branch)
    }

    fn defer_local_check(&self, pipeline_id: &str) -> bool {
        let host = self.clone();
        let id = pipeline_id.to_string();
        std::thread::Builder::new().name("pipeline-local-checks".into()).spawn(move || super::engine::run_local_checks(&host, &id)).is_ok()
    }

    fn run_local_check(&self, cwd: &Path, command: &str) -> Result<()> {
        let mut process = std::process::Command::new("/bin/sh");
        process.args(["-c", command]).current_dir(cwd);
        crate::git::output_within(process, std::time::Duration::from_secs(1800))
            .map(|_| ())
            .map_err(|error| match error {
                crate::git::RunError::TimedOut => anyhow!("The local check command exceeded 30 minutes."),
                _ => anyhow!("The local check command failed. Run the configured command in the workspace to inspect its output."),
            })
    }

    fn workspace(&self, cwd: &Path) -> Result<Workspace> {
        workspace(cwd)
    }

    fn base_ref(&self, cwd: &Path, base_branch: &str) -> String {
        base_ref(cwd, base_branch)
    }

    fn diff(&self, cwd: &Path, base: &str, head: &str) -> Result<Diff> {
        diff(cwd, base, head)
    }

    fn push(&self, cwd: &Path) -> Result<()> {
        push(cwd)
    }

    fn push_resolution(&self, cwd: &Path, branch: &str, head: &str) -> Result<()> {
        // Neither a changed checkout nor Git's push.default/upstream settings
        // may redirect this push. The exact verified commit goes to one ref.
        let target = format!("{head}:refs/heads/{branch}");
        crate::git::run_within(cwd, &["push", "origin", &target], PUSH_TIMEOUT, &|| false)
            .map_err(|error| anyhow!("Pushing the verified resolution failed: {error:?}"))
    }

    fn open_pull_request(&self, cwd: &Path, branch: &str) -> Result<Option<PrSnapshot>> {
        match crate::github::open_pr_for_branch(cwd, branch)? {
            Some(number) => crate::github::pr_snapshot(cwd, number).map(Some),
            None => Ok(None),
        }
    }

    fn create_pull_request(&self, cwd: &Path, title: &str, body: &str) -> Result<u64> {
        let base = crate::git::default_branch(cwd);
        let url = crate::github::create_pr(cwd, title, body, base.as_deref(), false)?;
        pr_number(&url).with_context(|| format!("GitHub opened the pull request but answered with {url:?}, which names no number."))
    }

    fn associate_pull_request(&self, session_id: &str, cwd: &Path, pr: &PrSnapshot) -> Result<()> {
        crate::pr_associations::record_local(session_id, cwd, &pr.url, &pr.head)
    }

    fn pull_request(&self, cwd: &Path, number: u64) -> Result<PrSnapshot> {
        crate::github::pr_snapshot(cwd, number)
    }

    fn edit_pull_request_body(&self, cwd: &Path, number: u64, body: &str) -> Result<()> {
        crate::github::edit_pr_body(cwd, number, body)
    }

    fn comment(&self, cwd: &Path, number: u64, body: &str) -> Result<String> {
        crate::github::comment_pr(cwd, number, body)
    }

    fn merge(&self, cwd: &Path, number: u64, method: &str, commit: &str) -> Result<PinnedMerge> {
        // The engine never asks this of a cloud workspace; should it ever, the
        // workspace's token is still not the reader's credentials.
        if self.cloud() {
            bail!("A cloud workspace does not merge pull requests. Merge it from the issue page in TerminalX on your computer, or on GitHub.");
        }
        crate::github::merge_pr_at(cwd, number, method, commit)
    }

    fn issue_body(&self, project_path: &str, issue: &IssueRef) -> Option<String> {
        let details = if issue.provider == "linear" {
            if self.cloud() {
                return None;
            }
            crate::issues::linear_details(&linear_key().ok()?, &issue.id)
        } else {
            crate::issues::github_details(Path::new(project_path), &issue_number(issue))
        };
        details.ok()?.body
    }

    fn move_to_review(&self, issue: &IssueRef) -> Result<Option<String>> {
        // The Linear key is the reader's and stays on their computer: a cloud
        // workspace's desktop makes the move when it sees the pull request,
        // and records it here (`engine::note_tracker`).
        if issue.provider != "linear" || self.cloud() {
            return Ok(None);
        }
        Ok(Some(review_move_line(&issue.identifier, crate::issues::linear_move_to_review(&linear_key()?, &issue.id)?)))
    }

    fn changed(&self, pipeline: &Pipeline) {
        self.sink.emit(CHANGED, pipeline);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reviewer_is_a_fresh_named_tab_owned_and_archived_with_the_author() {
        let _home = crate::store::temp_home();
        let mut author: SessionEntry = serde_json::from_value(serde_json::json!({
            "id": "author", "projectPath": "/repo", "cwd": "/repo/worktree", "title": "Issue",
            "created": "2026-10-12T00:00:00Z", "modified": "2026-10-12T00:00:00Z",
            "tabs": [{"id": "t1", "harness": "claude", "model": "opus", "effort": "high",
                "providerSessionId": "author-private-transcript", "created": "2026-10-12T00:00:00Z"}]
        })).unwrap();
        index::save(std::slice::from_ref(&author)).unwrap();
        let pipeline: Pipeline = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
        let sink = Arc::new(crate::sink::BroadcastSink::new(16));
        let manager = SessionManager::new(
            sink.clone(), Arc::new(crate::sink::NoObserver), Arc::new(crate::harness::host::Host::new()),
            Arc::new(crate::pty::Terminals::new()), Arc::new(Default::default()), Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        let added = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = added.clone();
        let host = LocalHost::cloud_workspace(sink, manager, Arc::new(move |id| observed.lock().unwrap().push(id.to_string())));
        let reviewer = host.open_reviewer(&pipeline, &author).unwrap();
        assert_eq!(reviewer.session_id, author.id);
        assert_ne!(reviewer.tab_id, "t1");
        assert_eq!(index::load().unwrap().len(), 1);
        let updated = index::get(&author.id).unwrap();
        let tab = updated.tab(&reviewer.tab_id).unwrap();
        assert_eq!(tab.title.as_deref(), Some("Reviewer"));
        assert!(tab.follow.title_pinned);
        assert_eq!((&tab.harness, &tab.model, &tab.effort, &tab.permission_mode),
            (&author.tabs[0].harness, &author.tabs[0].model, &author.tabs[0].effort, &author.tabs[0].permission_mode));
        assert!(tab.provider_session_id.is_none());
        assert!(tab.fork_from.is_none());
        assert!(tab.follow.history.is_empty());
        assert_eq!(updated.tabs[0], author.tabs[0]);
        assert_eq!(updated.cwd, author.cwd);
        assert_eq!(added.lock().unwrap().as_slice(), std::slice::from_ref(&reviewer.tab_id));
        // Archive only this synthetic owner; both conversations remain reachable.
        author = crate::session_ops::update_session_meta(&author.id, &crate::session_ops::SessionPatch { archived: Some(true), ..Default::default() }).unwrap();
        assert!(author.archived);
        assert!(author.tab(&reviewer.tab_id).is_some());
        assert!(author.tab("t1").is_some());
        assert!(host.merge(Path::new("/unused"), 1, "merge", "head").unwrap_err().to_string().contains("does not merge"));
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(cwd)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A real repository: `main` with one commit, and a branch off it.
    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("README.md"), "one\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "first"]);
        git(root, &["checkout", "-q", "-b", "raccoon/433-work"]);
        dir
    }

    #[test]
    fn conflicts_are_detected_without_editing_and_resolution_inputs_are_verified() {
        let dir = repository();
        let root = dir.path();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        git(root, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        git(root, &["push", "-q", "origin", "main"]);
        std::fs::write(root.join("README.md"), "branch intent\n").unwrap();
        git(root, &["commit", "-qam", "branch"]);
        push(root).unwrap();
        let original = workspace(root).unwrap();
        git(root, &["checkout", "-q", "main"]);
        std::fs::write(root.join("README.md"), "base intent\n").unwrap();
        git(root, &["commit", "-qam", "base"]);
        git(root, &["push", "-q", "origin", "main"]);
        git(root, &["checkout", "-q", "raccoon/433-work"]);
        let resolution = resolution_needed(root, "raccoon/433-work", "main", false).unwrap().unwrap();
        assert_eq!(workspace(root).unwrap().head, original.head);
        assert!(workspace(root).unwrap().dirty.is_empty());
        assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "branch intent\n");
        let merge = std::process::Command::new("git").current_dir(root).args(["-c", "user.name=T", "-c", "user.email=t@example.test", "merge", "--no-ff", "--no-commit", &resolution.base_commit]).output().unwrap();
        assert!(!merge.status.success());
        std::fs::write(root.join("README.md"), "branch intent\nbase intent\n").unwrap();
        git(root, &["add", "README.md"]);
        git(root, &["commit", "-qm", "preserve both intents"]);
        let head = git(root, &["rev-parse", "HEAD"]);
        verify_resolution(root, &resolution, &head, "raccoon/433-work").unwrap();
        // A remote writer invalidates even an otherwise valid merge.
        git(remote.path(), &["update-ref", "refs/heads/raccoon/433-work", &resolution.base_commit]);
        assert!(verify_resolution(root, &resolution, &head, "raccoon/433-work").unwrap_err().to_string().contains("Someone pushed"));
        // Another local commit invalidates the exact merge-parent contract.
        std::fs::write(root.join("extra.txt"), "another writer").unwrap();
        git(root, &["add", "extra.txt"]);
        git(root, &["commit", "-qm", "another writer"]);
        assert!(verify_resolution(root, &resolution, &git(root, &["rev-parse", "HEAD"]), "raccoon/433-work").is_err());
    }

    #[test]
    fn a_checkout_is_read_for_its_commit_its_branch_and_what_is_uncommitted() {
        let dir = repository();
        let root = dir.path();
        let fresh = workspace(root).unwrap();
        assert_eq!(fresh.head, git(root, &["rev-parse", "HEAD"]));
        assert_eq!((fresh.branch.as_deref(), fresh.default_branch.as_deref()), (Some("raccoon/433-work"), Some("main")));
        assert!(fresh.dirty.is_empty());
        assert_eq!(fresh.ahead_of_base, 0, "a branch with nothing of its own has nothing to open a pull request for");

        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/auth.rs"), "fn check() {}\n").unwrap();
        std::fs::write(root.join("README.md"), "one\ntwo\n").unwrap();
        // Untracked and modified both count: either would be left out of the pull request.
        let mut dirty = workspace(root).unwrap().dirty;
        dirty.sort();
        assert_eq!(dirty, ["README.md", "src/"]);

        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "second"]);
        let committed = workspace(root).unwrap();
        assert!(committed.dirty.is_empty());
        assert_eq!(committed.ahead_of_base, 1);
        assert_ne!(committed.head, fresh.head);

        assert!(workspace(tempfile::tempdir().unwrap().path()).unwrap_err().to_string().contains("is not a Git checkout"));
    }

    #[test]
    fn a_push_goes_to_the_branchs_own_remote_branch_and_a_refusal_is_reported_in_gits_words() {
        let dir = repository();
        let root = dir.path();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        git(root, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        std::fs::write(root.join("work.txt"), "work\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "work"]);
        // The first push names the upstream; the remote gets this branch and no other.
        push(root).unwrap();
        assert_eq!(git(remote.path(), &["for-each-ref", "--format=%(refname)"]), "refs/heads/raccoon/433-work");
        assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/raccoon/433-work"]), git(root, &["rev-parse", "HEAD"]));
        // Later pushes follow it.
        std::fs::write(root.join("work.txt"), "more\n").unwrap();
        git(root, &["commit", "-q", "-am", "more"]);
        push(root).unwrap();
        assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/raccoon/433-work"]), git(root, &["rev-parse", "HEAD"]));
        // A push the remote will not take (history rewritten locally) is not forced.
        git(root, &["reset", "-q", "--hard", "HEAD~1"]);
        std::fs::write(root.join("work.txt"), "different\n").unwrap();
        git(root, &["commit", "-q", "-am", "different"]);
        let refused = push(root).unwrap_err().to_string();
        assert!(refused.contains("rejected") || refused.contains("non-fast-forward"), "{refused}");
        assert_ne!(git(remote.path(), &["rev-parse", "refs/heads/raccoon/433-work"]), git(root, &["rev-parse", "HEAD"]));
    }

    #[test]
    fn a_branchs_diff_is_what_it_changed_and_not_what_its_base_gained() {
        let dir = repository();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/auth.rs"), "fn check_permissions() {}\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "branch work"]);
        let head = git(root, &["rev-parse", "HEAD"]);
        // Meanwhile main moves on with a file of its own.
        git(root, &["checkout", "-q", "main"]);
        std::fs::write(root.join("deploy.yml"), "on: push\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "main moves"]);
        git(root, &["checkout", "-q", "raccoon/433-work"]);

        // With no remote, the base is the local branch.
        let base = base_ref(root, "main");
        assert_eq!(base, "main");
        let changed = diff(root, &base, &head).unwrap();
        assert_eq!(changed.paths, ["src/auth.rs"]);
        assert!(changed.patch.contains("+fn check_permissions() {}") && !changed.patch.contains("deploy.yml"));
        // And it is what the security pass and the protected categories are judged on.
        assert_eq!(crate::issue_pipeline::categories::security_areas(&changed.paths, &changed.patch), ["authorization"]);

        // A file moved out of a protected place is still a change to that place.
        git(root, &["mv", "src/auth.rs", "notes.txt"]);
        git(root, &["commit", "-q", "-m", "move it"]);
        let moved = diff(root, &base, &git(root, &["rev-parse", "HEAD"])).unwrap();
        assert_eq!(moved.paths, ["notes.txt"], "added and removed again within the branch: only where it ended up");
        git(root, &["checkout", "-q", "main"]);
        std::fs::create_dir_all(root.join("db/migrations")).unwrap();
        std::fs::write(root.join("db/migrations/0042_add.sql"), "create table plans (id int);\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "a migration on main"]);
        git(root, &["checkout", "-q", "-b", "raccoon/434-move", "main"]);
        git(root, &["mv", "db/migrations/0042_add.sql", "old.txt"]);
        git(root, &["commit", "-q", "-m", "move the migration away"]);
        let mut renamed = diff(root, "main", &git(root, &["rev-parse", "HEAD"])).unwrap().paths;
        renamed.sort();
        assert_eq!(renamed, ["db/migrations/0042_add.sql", "old.txt"]);
        git(root, &["checkout", "-q", "raccoon/433-work"]);

        // A fetched remote branch is preferred: it is what the pull request merges into.
        git(root, &["update-ref", "refs/remotes/origin/main", "main"]);
        assert_eq!(base_ref(root, "main"), "origin/main");
        assert_eq!(diff(root, "origin/main", &head).unwrap().paths, ["src/auth.rs"]);
        assert!(diff(root, "origin/main", "0000000").is_err());
    }

    #[test]
    fn a_tabs_last_reply_is_its_last_finished_turns() {
        let event = |seq: u64, ts: &str, subagent: bool, payload: serde_json::Value| -> crate::events::AgentEvent {
            serde_json::from_value(serde_json::json!({
                "id": format!("e{seq}"), "sessionId": "s", "tabId": "t", "harness": "claude", "seq": seq, "ts": ts,
                "subagent": if subagent { serde_json::json!({ "id": "sub" }) } else { serde_json::Value::Null }, "payload": payload,
            }))
            .unwrap()
        };
        let mut events = vec![
            event(1, "2026-10-18T10:00:00.000Z", false, serde_json::json!({ "type": "turn_started" })),
            event(2, "2026-10-18T10:01:00.000Z", false, serde_json::json!({ "type": "assistant_text", "text": "Working on it." })),
            event(3, "2026-10-18T10:02:00.000Z", false, serde_json::json!({ "type": "assistant_text", "text": "Done.\n```terminalx-status\n{}\n```" })),
            event(4, "2026-10-18T10:02:30.000Z", true, serde_json::json!({ "type": "assistant_text", "text": "a subagent's aside" })),
            event(5, "2026-10-18T10:03:00.000Z", false, serde_json::json!({ "type": "turn_completed", "status": "ok" })),
        ];
        let (at, reply) = last_reply(&events).unwrap();
        assert_eq!(at.to_rfc3339(), "2026-10-18T10:03:00+00:00");
        assert!(reply.starts_with("Done."), "{reply}");
        // The turn's own final text, where it has one.
        events.push(event(6, "2026-10-18T11:00:00.000Z", false, serde_json::json!({ "type": "turn_started" })));
        events.push(event(7, "2026-10-18T11:01:00.000Z", false, serde_json::json!({ "type": "turn_completed", "status": "ok", "finalText": "All of it." })));
        assert_eq!(last_reply(&events).unwrap().1, "All of it.");
        // A turn that was aborted is not a reply.
        events.push(event(8, "2026-10-18T12:00:00.000Z", false, serde_json::json!({ "type": "turn_started" })));
        events.push(event(9, "2026-10-18T12:01:00.000Z", false, serde_json::json!({ "type": "turn_completed", "status": "aborted" })));
        assert_eq!(last_reply(&events).unwrap().1, "All of it.");
        assert!(last_reply(&[]).is_none());
    }

    #[test]
    fn a_pull_request_number_is_read_from_the_url_gh_prints() {
        assert_eq!(pr_number("https://github.com/acme/widgets/pull/433\n"), Some(433));
        assert_eq!(pr_number("https://github.com/acme/widgets/pull/433/"), Some(433));
        assert_eq!(pr_number("https://github.com/acme/widgets/issues/433"), None);
        assert_eq!(pr_number("Creating pull request..."), None);
        assert_eq!(pr_number(""), None);
    }
}
