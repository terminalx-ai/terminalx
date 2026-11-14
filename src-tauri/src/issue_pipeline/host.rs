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

use super::engine::{AgentStop, Diff, Host, Workspace};
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

    /// A turn ended in a tab that owes a report (`worker_report`): it is asked
    /// once more when the reply has none.
    pub(crate) fn worker_turn_completed(&self, session_id: &str, tab_id: &str, final_message: Option<&str>) {
        let to = SessionRef { session_id: session_id.into(), tab_id: tab_id.into() };
        crate::worker_report::turn_completed(final_message, || self.manager.load_events(session_id, tab_id), |prompt| Host::send(self, &to, prompt));
        // A run's worker: its piece follows what it just reported.
        // A try that fell short is followed by the next without anything more from here: the read of the run asks its host for that.
        crate::orchestration::engine::worker_turn_ended(&crate::orchestration::host::ManagerHost::new(self.sink.clone(), self.manager.clone()), session_id);
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
pub(crate) fn last_reply(events: &[crate::events::AgentEvent]) -> Option<(DateTime<Utc>, String)> {
    use crate::events::{Payload, TurnStatus};
    let end = events.iter().rposition(|event| event.subagent.is_none() && matches!(event.payload, Payload::TurnCompleted { status: TurnStatus::Ok, .. }))?;
    let at = DateTime::parse_from_rfc3339(&events[end].ts).ok()?.with_timezone(&Utc);
    let (_, reply) = crate::reply_block::turn_reply(events, end)?;
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
        merging: crate::unfinished_merge::merge_heads(cwd)?,
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

#[cfg(test)]
pub(crate) fn privacy_transfer_entry(cwd: &Path, action: &str) -> Result<()> {
    match action {
        "push" => push(cwd),
        "read" => remote_head(cwd, "origin", "main").map(|_| ()),
        "fetch" => resolution_needed(cwd, "main", "main", false, None).map(|_| ()),
        _ => unreachable!(),
    }
}

#[cfg(test)]
pub(crate) fn privacy_resolution(cwd: &Path) -> Result<Option<super::Resolution>> {
    resolution_needed(cwd, "privacy-conflict", "main", false, None)
}

/// Push the checkout's branch, setting its upstream the first time. Never
/// forced, and with a deadline: a push that hangs must not hold the pipeline.
fn push(cwd: &Path) -> Result<()> {
    let _request = crate::github_process::scope();
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

fn push_destination(cwd: &Path, remote: &str, url: &str) -> Result<(String, String)> {
    use sha2::Digest;
    // Pin transport rewrites too, without saving potentially credentialed URLs.
    let expanded = crate::git::run(cwd, &["remote", "get-url", "--push", "--all", remote])?;
    let urls: Vec<_> = expanded.lines().filter(|url| !url.is_empty()).collect();
    if urls.len() != 1 { bail!("Conflict resolution requires exactly one push destination."); }
    let mut hash = sha2::Sha256::new();
    hash.update(url.as_bytes());
    hash.update([0]);
    hash.update(expanded.as_bytes());
    Ok((urls[0].into(), format!("{:x}", hash.finalize())))
}

fn resolution_target(cwd: &Path, branch: &str, pr: Option<&PrSnapshot>) -> Result<super::ResolutionTarget> {
    let repository = pr.map(|pr| pr.head_repository.clone().context("GitHub did not identify the PR head repository. Refresh the pull request before resolving conflicts.")).transpose()?;
    let (remote, url) = match &repository {
        Some(repo) => crate::github::head_push_destination(cwd, branch, repo)?,
        None => {
            let remote = crate::git::push_remote(cwd, branch).unwrap_or_else(|| "origin".into());
            let url = crate::git::configured_push_url(cwd, &remote)?;
            (remote, url)
        }
    };
    let (_, url_hash) = push_destination(cwd, &remote, &url)?;
    Ok(super::ResolutionTarget { remote, repository, url_hash })
}

fn resolution_push_url(cwd: &Path, resolution: &super::Resolution) -> Result<String> {
    let target = resolution.target.as_ref().context("This resolution has no verified push destination. Start conflict resolution again before pushing.")?;
    let url = crate::git::configured_push_url(cwd, &target.remote)?;
    let (push_url, hash) = push_destination(cwd, &target.remote, &url)?;
    if hash != target.url_hash {
        bail!("The conflict-resolution push destination changed. Nothing was pushed; start resolution again.");
    }
    if target.repository.is_some() && resolution.remote_head.is_none() {
        bail!("The pull request branch was not observed at its verified push destination. Nothing was pushed.");
    }
    Ok(push_url)
}

fn verify_resolution(cwd: &Path, resolution: &super::Resolution, head: &str, branch: &str) -> Result<()> {
    let _request = crate::github_process::scope();
        // Exactly one merge, with the two pinned inputs. An extra author or
        // human commit changes the parents and is never silently pushed.
        let parents = crate::git::run(cwd, &["show", "-s", "--format=%P", head, "--"])?;
        if parents.split_whitespace().collect::<Vec<_>>() != [resolution.head.as_str(), resolution.base_commit.as_str()] {
            bail!("The checkout changed during resolution, or the result is not one merge of the pinned inputs. Review the commits manually.");
        }
        let url = resolution_push_url(cwd, resolution)?;
        if remote_head(cwd, &url, branch)? != resolution.remote_head {
            bail!("Someone pushed to this branch during conflict resolution. Nothing was pushed; reconcile the new remote head manually.");
        }
        Ok(())
}

fn remote_head(cwd: &Path, url: &str, branch: &str) -> Result<Option<String>> {
    let _request = crate::github_process::scope();
    let reference = format!("refs/heads/{branch}");
    let output = crate::git::transfer_output(cwd, &["ls-remote", "--heads", "--", url, &reference], std::time::Duration::from_secs(30)).map_err(|error| anyhow!("Reading the remote branch failed: {error:?}"))?;
    Ok(output.lines().find_map(|line| {
        let (sha, name) = line.split_once('\t')?;
        (name == reference).then(|| sha.to_string())
    }))
}

/// The base branch's commit as the remote has it now, fetched: the pull
/// request's base repository when there is a pull request, `origin` when not.
fn fetch_base(cwd: &Path, base: &str, pr: Option<&PrSnapshot>) -> Result<String> {
    let _request = crate::github_process::scope();
    Ok(if let Some(pr) = pr {
        if pr.base != base { bail!("The requested base branch does not match the pull request."); }
        let url = crate::github::base_fetch_destination(cwd, pr)?;
        let commit = remote_head(cwd, &url, base)?.context("The pull request's base branch is missing from its repository.")?;
        // Fetch the exact observed base object. Neither stale origin refs nor
        // another fetch replacing FETCH_HEAD can select a different merge input.
        crate::git::run_within(cwd, &["fetch", "--no-tags", "--no-write-fetch-head", "--", &url, &commit], PUSH_TIMEOUT, &|| false)
            .map_err(|error| anyhow!("Fetching the pull request base failed: {error:?}"))?;
        crate::git::run(cwd, &["rev-parse", "--verify", &format!("{commit}^{{commit}}")])?.trim().to_string()
    } else {
        crate::git::run_within(cwd, &["fetch", "--no-tags", "origin"], PUSH_TIMEOUT, &|| false).map_err(|error| anyhow!("Fetching the base failed: {error:?}"))?;
        let base_ref = format!("refs/remotes/origin/{base}");
        crate::git::run(cwd, &["rev-parse", "--verify", &base_ref])?.trim().to_string()
    })
}

/// Whether the commits after `reviewed` only merge the pull request's base,
/// against the base as GitHub has it now (#947).
fn base_merges(cwd: &Path, reviewed: &str, head: &str, pr: &PrSnapshot) -> Result<super::carry::Carry> {
    let base_commit = fetch_base(cwd, &pr.base, Some(pr))?;
    super::carry::classify(cwd, &base_commit, reviewed, head)
}

/// `required`: GitHub asks for the merge, the branch behind or in conflict,
/// whatever `git merge-tree` says. The two can differ: with more than one
/// merge base, git merges the bases into one first and GitHub does not.
fn resolution_needed(cwd: &Path, branch: &str, base: &str, required: bool, pr: Option<&PrSnapshot>) -> Result<Option<super::Resolution>> {
    let _request = crate::github_process::scope();
    let base_commit = fetch_base(cwd, base, pr)?;
    let head = crate::git::run(cwd, &["rev-parse", "HEAD"])?.trim().to_string();
    let ahead = crate::git::run(cwd, &["rev-list", "--count", &format!("{base_commit}..{head}")])?;
    let behind_count = crate::git::run(cwd, &["rev-list", "--count", &format!("{head}..{base_commit}")])?;
    if ahead.trim() == "0" || behind_count.trim() == "0" { return Ok(None); }
    // merge-tree computes conflicts without changing the index or checkout.
    let output = crate::git::inspect_output(cwd, &["merge-tree", "--write-tree", &head, &base_commit])?;
    let conflicting = match output.status.code() {
        Some(0) => false,
        Some(1) => true,
        _ => bail!("Could not compare the branch with its locally available base objects: {}", String::from_utf8_lossy(&output.stderr)),
    };
    if !conflicting && !required { return Ok(None); }
    let target = resolution_target(cwd, branch, pr)?;
    let url = crate::git::configured_push_url(cwd, &target.remote)?;
    let (push_url, hash) = push_destination(cwd, &target.remote, &url)?;
    if hash != target.url_hash { bail!("The push destination changed while preparing conflict resolution."); }
    let remote_head = remote_head(cwd, &push_url, branch)?;
    if let Some(pr) = pr {
        if pr.head != branch || pr.state != "OPEN" || remote_head.as_deref() != Some(pr.head_sha.as_str()) {
            bail!("The pull request branch is missing or changed at its verified push destination. Refresh the pull request before resolving conflicts.");
        }
    }
    Ok(Some(super::Resolution { head, remote_head, target: Some(target), base: base.to_string(), base_commit, return_stage: super::Stage::Work, waiting_since: None }))
}

fn push_resolution(cwd: &Path, resolution: &super::Resolution, branch: &str, head: &str) -> Result<()> {
    // Recheck at the write boundary and pass the pinned URL directly: changing
    // the upstream, push.default or a remote name cannot redirect the write.
    verify_resolution(cwd, resolution, head, branch)?;
    let url = resolution_push_url(cwd, resolution)?;
    let target = format!("{head}:refs/heads/{branch}");
    crate::git::run_within(cwd, &["push", "--", &url, &target], PUSH_TIMEOUT, &|| false)
        .map_err(|error| anyhow!("Pushing the verified resolution failed: {error:?}"))
}

impl LocalHost {
    /// A conversation of its own in the author's session, named `title`: no fork, and none
    /// of the author's transcript. On `chosen`'s model and effort, else the author's.
    fn open_tab(&self, author: &SessionEntry, tab: &index::TabEntry, title: &str, chosen: Option<(String, Option<String>)>) -> Result<SessionRef> {
        let (model, effort) = chosen.unwrap_or_else(|| (tab.model.clone(), tab.effort.clone()));
        let opened = self.manager.add_tab(&author.id, &NewTab { transport: Default::default(), harness: tab.harness.clone(), model, effort, permission_mode: Some(tab.permission_mode.clone()) })?;
        crate::session_ops::rename_tab_entry(&author.id, &opened.id, Some(title.into())).map_err(anyhow::Error::msg)?;
        self.sink.emit("session_updated", &index::get(&author.id)?);
        if let Place::CloudWorkspace { tab_added } = &self.place {
            tab_added(&opened.id);
        }
        Ok(SessionRef { session_id: author.id.clone(), tab_id: opened.id })
    }
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
        let running = self.manager.is_running(&to.session_id, &to.tab_id)
            .then(|| self.manager.environment_changed(&SessionManager::pane_id(&to.tab_id))).transpose()?;
        crate::store::environment::prepare_unattended(&index::get(&to.session_id)?.cwd, running)?;
        self.manager.send(&to.session_id, &to.tab_id, prompt.to_string(), Vec::new())?;
        Ok(())
    }

    fn last_reply(&self, session: &SessionRef) -> Option<(DateTime<Utc>, String)> {
        last_reply(&self.manager.load_events(&session.session_id, &session.tab_id).ok()?)
    }

    fn agent_busy(&self, who: &SessionRef) -> bool {
        let status = index::get(&who.session_id).ok().and_then(|session| session.tab(&who.tab_id).map(|tab| tab.status));
        matches!(status, Some(index::TabStatus::InProgress | index::TabStatus::Waiting)) || !self.manager.pipeline_idle(&who.session_id, &who.tab_id)
    }

    fn background_work(&self, who: &SessionRef) -> Option<String> {
        self.manager.background_work(&who.session_id, &who.tab_id)
    }

    /// A terminal, or an agent a person started in one by hand, is theirs and
    /// never stopped; an idle one is stopped at once, however briefly it has
    /// been idle, and opening its tab later does not start it again.
    fn stop_agent(&self, who: &SessionRef, note: &str) -> Result<AgentStop> {
        self.manager.stop_if_idle(&who.session_id, &who.tab_id, note, std::time::Duration::ZERO)
    }

    /// An independent conversation in the owning session, with no fork or
    /// transcript copied from the author. Existing reviewer references are
    /// reused by the engine, including legacy separate sessions.
    fn open_reviewer(&self, pipeline: &Pipeline, author: &SessionEntry) -> Result<SessionRef> {
        let tab = author.tab(&pipeline.author.tab_id).context("the author's conversation is gone")?;
        // The project's reviewer model and effort, when it set them: a review need not run on
        // what the author ran on. The agent's list is read only for a project that chose.
        let chosen = crate::store::projects::issue_pipeline_settings(&author.project_path).ok().filter(|settings| settings.reviewer_model.is_some() || settings.reviewer_effort.is_some()).map(|settings| {
            let models = match tab.harness.as_str() {
                "claude" => crate::harness::claude::models::get(false),
                "codex" => self.manager.codex_models().get(false),
                _ => crate::models::catalog(),
            };
            settings.reviewer_choice(&tab.harness, &tab.model, tab.effort.as_deref(), &models)
        });
        self.open_tab(author, tab, "Reviewer", chosen)
    }

    fn workspace_idle(&self, _pipeline: &Pipeline, cwd: &Path) -> Result<bool> {
        let cwd = cwd.canonicalize()?;
        // Closed for work that is no conversation's turn: an orchestration run is being merged into it.
        if super::admission::closed(&cwd) { return Ok(false); }
        for session in index::load()? {
            if Path::new(&session.cwd).canonicalize().ok().as_ref() != Some(&cwd) { continue; }
            for tab in &session.tabs {
                if !matches!(tab.status, index::TabStatus::Idle | index::TabStatus::Completed)
                    || !self.manager.pipeline_idle(&session.id, &tab.id) { return Ok(false); }
            }
        }
        Ok(true)
    }

    fn resolution_needed(&self, cwd: &Path, branch: &str, base: &str, required: bool, pr: Option<&PrSnapshot>) -> Result<Option<super::Resolution>> {
        resolution_needed(cwd, branch, base, required, pr)
    }

    fn open_resolver(&self, pipeline: &Pipeline, author: &SessionEntry) -> Result<SessionRef> {
        // A resolver writes the merge the author would have: it runs on the author's model.
        let tab = author.tab(&pipeline.author.tab_id).context("the author's conversation is gone")?;
        self.open_tab(author, tab, "Conflict resolver", None)
    }

    fn verify_resolution(&self, cwd: &Path, resolution: &super::Resolution, head: &str, branch: &str) -> Result<()> {
        verify_resolution(cwd, resolution, head, branch)
    }

    fn base_merges(&self, cwd: &Path, reviewed: &str, head: &str, pr: &PrSnapshot) -> Result<super::carry::Carry> {
        base_merges(cwd, reviewed, head, pr)
    }

    fn abort_merge(&self, cwd: &Path, head: &str, merge_head: &str) -> Result<()> {
        crate::unfinished_merge::abort(cwd, head, merge_head)
    }

    fn defer_local_check(&self, pipeline_id: &str) -> bool {
        let host = self.clone();
        let id = pipeline_id.to_string();
        std::thread::Builder::new().name("pipeline-local-checks".into()).spawn(crate::github_process::queued(move || super::engine::run_local_checks(&host, &id))).is_ok()
    }

    fn startup_blocker(&self, pipeline: &Pipeline, new_validation: bool) -> Result<Option<String>> {
        if self.cloud() { return Ok(None); }
        let state = crate::startup::snapshot()?;
        let Some(incident) = state.active() else { return Ok(None) };
        let affected = new_validation || incident.blocked_pipelines.contains(&pipeline.id) || state.launches.iter().any(|launch|
            incident.launches.contains(&launch.id) && [Some(&pipeline.author), pipeline.reviewer.as_ref(), pipeline.resolver.as_ref()].into_iter().flatten().any(|who|
                launch.pane == SessionManager::pane_id(&who.tab_id) || crate::pty::shell_session(&launch.pane) == Some(who.session_id.as_str())));
        if affected { crate::startup::validation_blocker(Some(&pipeline.id)) } else { Ok(None) }
    }

    fn validation_pending(&self, pipeline: &Pipeline) -> Result<bool> {
        if self.cloud() { Ok(false) } else { crate::startup::validation_pending(&pipeline.id) }
    }

    fn run_local_check(&self, pipeline: &Pipeline, cwd: &Path, command: &str) -> Result<()> {
        if !self.cloud() {
            return crate::startup::run_validation(&SessionManager::pane_id(&pipeline.author.tab_id), &pipeline.id, cwd, command);
        }
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

    fn push_resolution(&self, cwd: &Path, resolution: &super::Resolution, branch: &str, head: &str) -> Result<()> {
        push_resolution(cwd, resolution, branch, head)
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

    #[test]
    fn a_pipeline_with_a_reviewer_model_set_opens_its_reviewer_on_that_model() {
        let _home = crate::store::temp_home();
        let repo = tempfile::tempdir().unwrap();
        let project = crate::store::projects::add(repo.path().to_str().unwrap()).unwrap();
        let author: SessionEntry = serde_json::from_value(serde_json::json!({
            "id": "author", "projectPath": project.path, "cwd": project.path, "title": "Issue",
            "created": "2026-11-11T00:00:00Z", "modified": "2026-11-11T00:00:00Z",
            "tabs": [{"id": "t1", "harness": "claude", "model": "opus", "effort": "xhigh", "permissionMode": "bypassPermissions", "created": "2026-11-11T00:00:00Z"}]
        })).unwrap();
        index::save(std::slice::from_ref(&author)).unwrap();
        let pipeline: Pipeline = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
        let sink = Arc::new(crate::sink::BroadcastSink::new(16));
        let manager = SessionManager::new(
            sink.clone(), Arc::new(crate::sink::NoObserver), Arc::new(crate::harness::host::Host::new()),
            Arc::new(crate::pty::Terminals::new()), Arc::new(Default::default()), Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        let host = LocalHost::new(sink, manager);
        let set = |model: Option<&str>, effort: Option<&str>| {
            let settings = IssuePipelineSettings { reviewer_model: model.map(str::to_owned), reviewer_effort: effort.map(str::to_owned), ..Default::default() };
            crate::store::projects::update(&project.path, crate::store::projects::ProjectPatch { issue_pipeline: Some(settings), ..Default::default() }).unwrap();
        };
        let opened = |who: SessionRef| {
            let tab = index::get("author").unwrap().tab(&who.tab_id).cloned().unwrap();
            (tab.title.clone().unwrap_or_default(), tab.harness.clone(), tab.model.clone(), tab.effort.clone(), tab.permission_mode.clone())
        };
        let on = |title: &str, model: &str, effort: Option<&str>| (title.to_string(), "claude".to_string(), model.to_string(), effort.map(str::to_owned), "bypassPermissions".to_string());
        // No choice made: the author's model and effort, as before.
        assert_eq!(opened(host.open_reviewer(&pipeline, &author).unwrap()), on("Reviewer", "opus", Some("xhigh")));
        // The project's reviewer model and effort: the reviewer runs on them, the author's mode kept.
        set(Some("sonnet"), Some("medium"));
        assert_eq!(opened(host.open_reviewer(&pipeline, &author).unwrap()), on("Reviewer", "sonnet", Some("medium")));
        // A model with no effort named runs at its own default, not at the author's xhigh.
        set(Some("sonnet"), None);
        assert_eq!(opened(host.open_reviewer(&pipeline, &author).unwrap()), on("Reviewer", "sonnet", None));
        // Only an effort: the author's model at that effort.
        set(None, Some("low"));
        assert_eq!(opened(host.open_reviewer(&pipeline, &author).unwrap()), on("Reviewer", "opus", Some("low")));
        // A model the author's agent does not offer cannot be launched: the author's stands.
        set(Some("gpt-6.1-terra"), Some("medium"));
        assert_eq!(opened(host.open_reviewer(&pipeline, &author).unwrap()), on("Reviewer", "opus", Some("medium")));
        // A conflict resolver writes code: it stays on the author's model whatever the reviewer's is.
        set(Some("sonnet"), Some("medium"));
        assert_eq!(opened(host.open_resolver(&pipeline, &author).unwrap()), on("Conflict resolver", "opus", Some("xhigh")));
        // The author's own tab is untouched by any of it.
        assert_eq!(index::get("author").unwrap().tabs[0], author.tabs[0]);
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
        let resolution = resolution_needed(root, "raccoon/433-work", "main", false, None).unwrap().unwrap();
        assert_eq!(workspace(root).unwrap().head, original.head);
        assert!(workspace(root).unwrap().dirty.is_empty());
        assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "branch intent\n");
        let merge = || std::process::Command::new("git").current_dir(root).args(["-c", "user.name=T", "-c", "user.email=t@example.test", "merge", "--no-ff", "--no-edit", &resolution.base_commit]).output().unwrap();
        assert!(!merge().status.success());
        // Stopped here, the checkout holds exactly the merge the pipeline asked for, and it can be undone.
        let half = workspace(root).unwrap();
        assert_eq!((half.head.as_str(), half.merging.as_slice()), (resolution.head.as_str(), std::slice::from_ref(&resolution.base_commit)));
        assert_eq!(half.dirty, ["README.md"]);
        crate::unfinished_merge::abort(root, &resolution.head, &resolution.base_commit).unwrap();
        let undone = workspace(root).unwrap();
        assert!(undone.merging.is_empty() && undone.dirty.is_empty() && undone.head == original.head);
        assert!(!merge().status.success());
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

    /// Real upstream/fork repositories, with Git URL rewrites keeping all
    /// transport local while preserving the GitHub repository identities.
    fn fork_with_conflicts() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir, PrSnapshot) {
        let dir = repository();
        let root = dir.path();
        let upstream = tempfile::tempdir().unwrap();
        let fork = tempfile::tempdir().unwrap();
        for (name, repo, bare) in [("origin", "acme/widgets", &upstream), ("fork", "me/widgets", &fork)] {
            git(bare.path(), &["init", "-q", "--bare", "-b", "main"]);
            let url = format!("https://github.com/{repo}.git");
            git(root, &["remote", "add", name, &url]);
            git(root, &["config", &format!("url.{}.insteadOf", bare.path().display()), &url]);
        }
        git(root, &["push", "-q", "origin", "main"]);
        git(root, &["push", "-q", "fork", "main"]);
        std::fs::write(root.join("README.md"), "branch intent\n").unwrap();
        git(root, &["commit", "-qam", "branch"]);
        git(root, &["push", "-q", "fork", "raccoon/433-work"]);
        git(root, &["config", "branch.raccoon/433-work.pushRemote", "fork"]);
        let pr = crate::github::parse_snapshot(&serde_json::json!({
            "number":7,"url":"https://github.com/acme/widgets/pull/7","state":"OPEN",
            "headRefName":"raccoon/433-work","baseRefName":"main","headRefOid":git(root, &["rev-parse", "HEAD"]),
            "isCrossRepository":true,"headRepositoryOwner":{"login":"me"},"headRepository":{"name":"widgets"}
        }));
        git(root, &["checkout", "-q", "main"]);
        std::fs::write(root.join("README.md"), "base intent\n").unwrap();
        git(root, &["commit", "-qam", "base"]);
        git(root, &["push", "-q", "origin", "main"]);
        git(root, &["checkout", "-q", "raccoon/433-work"]);
        (dir, upstream, fork, pr)
    }

    #[test]
    fn fork_resolution_verifies_and_pushes_only_the_pinned_pr_repository() {
        let (dir, upstream, fork, pr) = fork_with_conflicts();
        let root = dir.path();
        let branch = "raccoon/433-work";
        let reference = "refs/heads/raccoon/433-work";
        let resolution = resolution_needed(root, branch, "main", true, Some(&pr)).unwrap().unwrap();
        assert_eq!(resolution.remote_head.as_deref(), Some(pr.head_sha.as_str()));
        assert_eq!(resolution.target.as_ref().unwrap().repository.as_deref(), Some("me/widgets"));
        assert_eq!(resolution.target.as_ref().unwrap().remote, "fork");
        // The destination survives the resolver's turn and an app restart.
        let json = serde_json::to_string(&resolution).unwrap();
        assert!(!json.contains("https://"));
        let resolution: super::super::Resolution = serde_json::from_str(&json).unwrap();
        let merge = std::process::Command::new("git").current_dir(root)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.test", "merge", "--no-ff", "--no-edit", &resolution.base_commit]).output().unwrap();
        assert!(!merge.status.success());
        std::fs::write(root.join("README.md"), "branch intent\nbase intent\n").unwrap();
        git(root, &["add", "README.md"]);
        git(root, &["commit", "-qm", "preserve both intents"]);
        let head = git(root, &["rev-parse", "HEAD"]);
        verify_resolution(root, &resolution, &head, branch).unwrap();
        // Two missing observations must never authorize an existing PR push.
        let mut unverified = resolution.clone();
        unverified.remote_head = None;
        assert!(push_resolution(root, &unverified, branch, &head).is_err());
        // Legacy stored resolutions have no verified destination; fail closed.
        unverified.target = None;
        assert!(push_resolution(root, &unverified, branch, &head).is_err());
        // Changes at the fork (including deletion) invalidate the merge even
        // though origin's same-name branch is absent throughout this test.
        let ancestor = git(root, &["rev-parse", &format!("{}^", pr.head_sha)]);
        git(fork.path(), &["update-ref", reference, &ancestor]);
        assert!(verify_resolution(root, &resolution, &head, branch).unwrap_err().to_string().contains("Someone pushed"));
        assert!(push_resolution(root, &resolution, branch, &head).is_err());
        git(fork.path(), &["update-ref", "-d", reference]);
        assert!(push_resolution(root, &resolution, branch, &head).is_err());
        git(fork.path(), &["update-ref", reference, &pr.head_sha]);
        // A changed remote URL cannot redirect the already-verified result.
        git(root, &["config", "remote.fork.pushurl", "https://github.com/acme/widgets.git"]);
        assert!(push_resolution(root, &resolution, branch, &head).unwrap_err().to_string().contains("destination changed"));
        git(root, &["config", "--unset", "remote.fork.pushurl"]);
        // Transport rewrites are part of the pin as well as remote URLs.
        let fork_rewrite = format!("url.{}.insteadOf", fork.path().display());
        let upstream_rewrite = format!("url.{}.insteadOf", upstream.path().display());
        git(root, &["config", "--unset", &fork_rewrite]);
        git(root, &["config", "--add", &upstream_rewrite, "https://github.com/me/widgets.git"]);
        assert!(push_resolution(root, &resolution, branch, &head).unwrap_err().to_string().contains("destination changed"));
        git(root, &["config", "--unset", "--fixed-value", &upstream_rewrite, "https://github.com/me/widgets.git"]);
        git(root, &["config", &fork_rewrite, "https://github.com/me/widgets.git"]);
        // Changing Git's default push remote also cannot redirect this push.
        git(root, &["config", "branch.raccoon/433-work.pushRemote", "origin"]);
        push_resolution(root, &resolution, branch, &head).unwrap();
        assert_eq!(git(fork.path(), &["rev-parse", reference]), head);
        assert!(git(root, &["ls-remote", upstream.path().to_str().unwrap(), reference]).is_empty());
        assert_eq!(git(upstream.path(), &["rev-parse", "main"]), resolution.base_commit);
    }

    #[test]
    fn fork_resolution_rejects_missing_or_unverified_heads_and_ambiguous_push_urls() {
        let (dir, upstream, fork, mut pr) = fork_with_conflicts();
        let root = dir.path();
        let branch = "raccoon/433-work";
        pr.head_repository = None;
        assert!(resolution_needed(root, branch, "main", true, Some(&pr)).is_err());
        pr.head_repository = Some("someone/widgets".into());
        assert!(resolution_needed(root, branch, "main", true, Some(&pr)).is_err());
        pr.head_repository = Some("me/widgets".into());
        git(root, &["config", "--add", "remote.fork.pushurl", "https://github.com/me/widgets.git"]);
        git(root, &["config", "--add", "remote.fork.pushurl", "https://github.com/acme/widgets.git"]);
        assert!(resolution_needed(root, branch, "main", true, Some(&pr)).is_err());
        git(root, &["config", "--unset-all", "remote.fork.pushurl"]);
        git(fork.path(), &["update-ref", "-d", "refs/heads/raccoon/433-work"]);
        let error = resolution_needed(root, branch, "main", true, Some(&pr)).unwrap_err();
        assert!(error.to_string().contains("missing or changed"));
        assert!(git(root, &["ls-remote", upstream.path().to_str().unwrap(), "refs/heads/raccoon/433-work"]).is_empty());
    }

    #[test]
    fn fork_origin_resolves_the_actual_upstream_base_even_when_its_own_main_is_stale() {
        for configured_upstream in [true, false] {
            let (dir, upstream, fork, pr) = fork_with_conflicts();
            let root = dir.path();
            let branch = "raccoon/433-work";
            git(root, &["remote", "rename", "origin", "upstream"]);
            git(root, &["remote", "rename", "fork", "origin"]);
            let stale_base = git(root, &["rev-parse", "origin/main"]);
            let actual_base = git(upstream.path(), &["rev-parse", "main"]);
            assert_ne!(stale_base, actual_base);
            assert_eq!(git(root, &["rev-list", "--count", "HEAD..origin/main"]), "0");
            if configured_upstream {
                let alias = "git@github-work:acme/widgets.git";
                git(root, &["remote", "set-url", "upstream", alias]);
                git(root, &["config", "--add", &format!("url.{}.insteadOf", upstream.path().display()), alias]);
                assert_eq!(crate::github::base_fetch_destination(root, &pr).unwrap(), alias);
            } else {
                git(root, &["remote", "remove", "upstream"]);
                assert_eq!(crate::github::base_fetch_destination(root, &pr).unwrap(), "https://github.com/acme/widgets.git");
            }
            let resolution = resolution_needed(root, branch, "main", true, Some(&pr)).unwrap().expect("the upstream main really conflicts");
            assert_eq!(resolution.base_commit, actual_base);
            assert_eq!(resolution.target.as_ref().unwrap().remote, "origin");
            assert_eq!(resolution.target.as_ref().unwrap().repository.as_deref(), Some("me/widgets"));
            let merge = std::process::Command::new("git").current_dir(root)
                .args(["-c", "user.name=T", "-c", "user.email=t@example.test", "merge", "--no-ff", "--no-edit", &resolution.base_commit]).output().unwrap();
            assert!(!merge.status.success());
            assert_eq!(workspace(root).unwrap().merging.as_slice(), std::slice::from_ref(&actual_base));
            std::fs::write(root.join("README.md"), "branch intent\nbase intent\n").unwrap();
            git(root, &["add", "README.md"]);
            git(root, &["commit", "-qm", "resolve against upstream"]);
            let head = git(root, &["rev-parse", "HEAD"]);
            verify_resolution(root, &resolution, &head, branch).unwrap();
            push_resolution(root, &resolution, branch, &head).unwrap();
            assert_eq!(git(fork.path(), &["rev-parse", &format!("refs/heads/{branch}")]), head);
            assert_eq!(git(fork.path(), &["rev-parse", "main"]), stale_base);
            assert_eq!(git(upstream.path(), &["rev-parse", "main"]), actual_base);
            assert!(git(root, &["ls-remote", upstream.path().to_str().unwrap(), &format!("refs/heads/{branch}")]).is_empty());
        }
    }

    #[test]
    fn a_missing_pr_base_never_falls_back_to_the_forks_main() {
        let (dir, upstream, _fork, mut pr) = fork_with_conflicts();
        let root = dir.path();
        git(root, &["remote", "rename", "origin", "upstream"]);
        git(root, &["remote", "rename", "fork", "origin"]);
        git(upstream.path(), &["update-ref", "-d", "refs/heads/main"]);
        let error = resolution_needed(root, "raccoon/433-work", "main", true, Some(&pr)).unwrap_err();
        assert!(error.to_string().contains("base branch is missing"));
        pr.url = "https://github.com/acme/widgets/pull/8".into();
        assert!(resolution_needed(root, "raccoon/433-work", "main", true, Some(&pr)).unwrap_err().to_string().contains("does not match"));
    }

    /// #748: the branch merged another pull request's branch before main
    /// did, so the two have two merge bases. git merges them cleanly; GitHub,
    /// from one base, finds a conflict and asks for the merge.
    #[test]
    fn a_merge_github_asks_for_is_pinned_even_where_git_finds_no_conflict() {
        let dir = repository();
        let root = dir.path();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        git(root, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        let commit_file = |file: &str, text: &str, message: &str| {
            std::fs::write(root.join(file), text).unwrap();
            git(root, &["add", file]);
            git(root, &["commit", "-qm", message]);
        };
        git(root, &["checkout", "-q", "main"]);
        commit_file("usage.txt", "a\nb\n", "usage");
        git(root, &["checkout", "-q", "-b", "other"]);
        commit_file("usage.txt", "a\nother\nb\n", "the other pull request");
        git(root, &["checkout", "-q", "main"]);
        commit_file("base.txt", "base\n", "the base moves on");
        let base_then = git(root, &["rev-parse", "HEAD"]);
        git(root, &["branch", "-q", "-f", "raccoon/433-work", "main"]);
        git(root, &["checkout", "-q", "raccoon/433-work"]);
        git(root, &["merge", "-q", "--no-ff", "--no-edit", "other"]);
        commit_file("usage.txt", "a\nother\nwork\nb\n", "work next to the other change");
        push(root).unwrap();
        git(root, &["checkout", "-q", "main"]);
        git(root, &["merge", "-q", "--no-ff", "--no-edit", "other"]);
        git(root, &["push", "-q", "origin", "main"]);
        git(root, &["checkout", "-q", "raccoon/433-work"]);
        assert_eq!(git(root, &["merge-base", "--all", "main", "HEAD"]).lines().count(), 2);
        let from_one_base = |base: &str| std::process::Command::new("git").current_dir(root).args(["merge-tree", "--write-tree", &format!("--merge-base={base}"), "origin/main", "HEAD"]).output().unwrap().status.code();
        assert_eq!(from_one_base(&base_then), Some(1), "GitHub's view: a conflict");

        assert_eq!(resolution_needed(root, "raccoon/433-work", "main", false, None).unwrap(), None, "git's view: nothing to resolve");
        let resolution = resolution_needed(root, "raccoon/433-work", "main", true, None).unwrap().unwrap();
        assert_eq!(resolution.base_commit, git(root, &["rev-parse", "origin/main"]));
        git(root, &["merge", "-q", "--no-ff", "--no-edit", &resolution.base_commit]);
        let head = git(root, &["rev-parse", "HEAD"]);
        verify_resolution(root, &resolution, &head, "raccoon/433-work").unwrap();
        assert_eq!(git(root, &["merge-base", "--all", "origin/main", "HEAD"]), resolution.base_commit, "one merge base left");
        assert_eq!(std::fs::read_to_string(root.join("usage.txt")).unwrap(), "a\nother\nwork\nb\n");
        // With the base merged in, nothing more is asked for.
        assert_eq!(resolution_needed(root, "raccoon/433-work", "main", true, None).unwrap(), None);
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
