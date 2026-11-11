//! The session header's next Git step. Reads are published after one complete
//! refresh; actions re-read their inputs and never force push or bypass GitHub rules.
use std::{collections::{HashMap, HashSet}, path::Path, sync::{atomic::{AtomicU64, Ordering}, LazyLock, Mutex}, time::{Duration, Instant}};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::{git::{self, WorkStatus}, github::{self, PrSnapshot}, issue_pipeline::gate::{check_bucket, CheckBucket}, store::index::SessionEntry};

pub const EVENT: &str = "branch_step_changed";
static REVISION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Hidden, NoPr, AgentWorking, Uncommitted, Behind, Ahead, Diverged, Conflicts,
    ChangesRequested, Draft, ChecksFailing, ChecksPending, ReviewRequired, Ready, Merged,
}

/// Local work takes precedence over hosted readiness. Unknown check conclusions
/// and unpublished requirements cannot turn into an enabled Merge button.
pub fn resolve(work: &WorkStatus, pr: Option<&PrSnapshot>, working: bool) -> Step {
    if working { return Step::AgentWorking; }
    use crate::branch_overview::LocalStep;
    // GitHub describes the published head. A local resolution waiting to be
    // pushed must not inherit that older head's base conflicts/behind status.
    let current_pr = pr.filter(|pr| pr.state == "OPEN" && work.head.as_deref() == Some(&pr.head_sha));
    let base_conflicts = current_pr.is_some_and(|pr| pr.mergeable == "CONFLICTING" || pr.merge_state == "DIRTY");
    // A PR base that must advance also takes precedence over committing dirt.
    let base_behind = current_pr.is_some_and(|pr| pr.merge_state == "BEHIND");
    let local = crate::branch_overview::next_step(work, base_conflicts, work.ahead_of_base.unwrap_or(1), true);
    match local {
        Some(LocalStep::Conflicts) => return Step::Conflicts,
        Some(LocalStep::Reconcile) => return Step::Diverged,
        Some(LocalStep::Pull) => return Step::Behind,
        _ if base_behind => return Step::Behind,
        Some(LocalStep::Commit) => return Step::Uncommitted,
        Some(LocalStep::Push) => return Step::Ahead,
        _ => {}
    }
    let Some(pr) = pr else { return Step::NoPr; };
    if pr.state == "MERGED" {
        return if work.head.as_deref() == Some(&pr.head_sha) { Step::Merged } else { Step::NoPr };
    }
    if pr.state != "OPEN" { return Step::NoPr; }
    if pr.review_decision.as_deref() == Some("CHANGES_REQUESTED") { return Step::ChangesRequested; }
    if pr.is_draft { return Step::Draft; }
    if pr.checks_unread || work.head.as_deref() != Some(&pr.head_sha) { return Step::ChecksPending; }
    let checks: Vec<_> = pr.checks.iter().chain(pr.validation.iter().flatten()).collect();
    if checks.iter().any(|c| check_bucket(&c.state) == CheckBucket::Fail) { return Step::ChecksFailing; }
    if checks.iter().any(|c| check_bucket(&c.state) == CheckBucket::Pending)
        || pr.required_checks.as_ref().is_some_and(|names| names.iter().any(|name| !pr.checks.iter().any(|c| &c.name == name))) {
        return Step::ChecksPending;
    }
    if pr.review_decision.as_deref() == Some("REVIEW_REQUIRED") || pr.merge_state == "BLOCKED" { return Step::ReviewRequired; }
    if pr.mergeable != "MERGEABLE" || pr.merge_state != "CLEAN" { return Step::ChecksPending; }
    Step::Ready
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action { CreatePr, CommitPush, Push, Pull, ResolveConflicts, FixChecks, AddressReview, MarkReady, Merge }

impl Action {
    pub fn publishes(self) -> bool { matches!(self, Self::CreatePr | Self::CommitPush | Self::Push | Self::Merge) }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub session_id: String,
    pub cwd: String,
    pub branch: String,
    pub head: String,
    pub base: String,
    pub merge_method: String,
    pub state: Step,
    pub actions: Vec<Action>,
    pub pr: Option<PrSnapshot>,
    pub behind_upstream: bool,
    pub pull_needs_agent: bool,
}

fn actions(step: Step, pr: Option<&PrSnapshot>) -> Vec<Action> {
    use Action::*;
    let mut available = match step {
        Step::Hidden | Step::AgentWorking | Step::Merged => vec![],
        Step::Uncommitted => vec![CommitPush],
        Step::Ahead => vec![Push],
        Step::Behind => vec![Pull],
        Step::Diverged | Step::Conflicts => vec![ResolveConflicts],
        Step::ChangesRequested => vec![AddressReview],
        Step::ChecksFailing => vec![FixChecks],
        Step::Draft => vec![MarkReady],
        Step::Ready => vec![Merge],
        Step::NoPr => vec![CreatePr],
        Step::ChecksPending | Step::ReviewRequired => vec![],
    };
    if step == Step::Ahead && pr.is_none_or(|pr| pr.state != "OPEN") { available.push(CreatePr); }
    // The primary step has priority; other applicable PR actions stay in the
    // menu (for example fixing CI while a PR is still a draft).
    if matches!(step, Step::ChangesRequested | Step::Draft | Step::ChecksFailing | Step::ChecksPending | Step::ReviewRequired | Step::Ready) {
        if let Some(pr) = pr.filter(|pr| pr.state == "OPEN") {
            if pr.is_draft && !available.contains(&MarkReady) { available.push(MarkReady); }
            if pr.checks.iter().chain(pr.validation.iter().flatten()).any(|c| check_bucket(&c.state) == CheckBucket::Fail) && !available.contains(&FixChecks) {
                available.push(FixChecks);
            }
        }
    }
    available
}

fn checkout(session: &SessionEntry) -> Result<&Path> {
    if session.worktree_removed { bail!("This workspace has been removed."); }
    if session.is_quick() { bail!("Use the repository's session for Git actions."); }
    Ok(Path::new(&session.cwd))
}

fn read_work(cwd: &Path) -> Result<WorkStatus> {
    // work_status is infallible for other callers. Never offer a header write
    // if status could not be read. A conflicted rebase detaches HEAD, but its
    // recorded branch still lets the user ask the agent to finish the rebase.
    git::run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"])?;
    let mut work = git::work_status(cwd);
    if work.branch.is_none() && work.operation.as_deref() == Some("rebase") {
        let dir = git::run(cwd, &["rev-parse", "--absolute-git-dir"])?;
        for marker in ["rebase-merge/head-name", "rebase-apply/head-name"] {
            if let Ok(name) = std::fs::read_to_string(Path::new(dir.trim()).join(marker)) {
                if let Some(branch) = name.trim().strip_prefix("refs/heads/") {
                    if git::run(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
                        work.branch = Some(branch.to_string());
                        break;
                    }
                }
            }
        }
    }
    if work.upstream.is_none() {
        work.upstream = git::comparison_ref(cwd).map(|r| r.strip_prefix("refs/remotes/").unwrap_or(&r).to_string());
    }
    Ok(work)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Refresh { Local, Auto, Remote }

const REMOTE_EVERY: Duration = Duration::from_secs(5 * 60);
#[derive(Default)]
struct Hosted {
    pr: Option<PrSnapshot>,
    known: bool,
    next: Option<Instant>,
    failures: u32,
    running: bool,
}
impl Hosted {
    fn start(&mut self, mode: Refresh, now: Instant) -> bool {
        if mode == Refresh::Local || self.running || (mode != Refresh::Remote && self.next.is_some_and(|next| now < next)) { return false; }
        self.running = true;
        true
    }
    fn finish(&mut self, result: Result<Option<PrSnapshot>>, now: Instant) {
        self.running = false;
        match result {
            Ok(pr) => { self.pr = pr; self.known = true; self.failures = 0; }
            Err(_) => { self.known = false; self.failures = self.failures.saturating_add(1); }
        }
        self.next = Some(now + REMOTE_EVERY * 2_u32.pow(self.failures.min(4)));
    }
}
static HOSTED: LazyLock<Mutex<HashMap<String, Hosted>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn supported(work: &WorkStatus, remote: Option<&str>) -> bool {
    work.branch.is_some() && work.branch != work.default_branch && work.head.is_some()
        && remote.is_some_and(|remote| crate::github_identity::remote_host_kind(remote) == "github")
}

fn hidden(session: &SessionEntry, revision: u64) -> Snapshot {
    Snapshot { revision, session_id: session.id.clone(), cwd: session.cwd.clone(),
        branch: String::new(), head: String::new(), base: String::new(), merge_method: "merge".into(), state: Step::Hidden,
        actions: vec![], pr: None, behind_upstream: false, pull_needs_agent: false }
}

/// Frequent reads only inspect local Git and cached hosted status. An automatic
/// hosted read is shared per checkout/branch/remote, survives view remounts and
/// backs off (10, 20, 40, 80 minutes) after errors. Manual refresh bypasses it.
pub fn preview(session: &SessionEntry, working: bool, mode: Refresh) -> Result<Snapshot> {
    let _request = crate::github_process::scope();
    let revision = REVISION.fetch_add(1, Ordering::Relaxed);
    let cwd = checkout(session)?;
    let work = read_work(cwd)?;
    let remote = git::remote_url(cwd);
    if !supported(&work, remote.as_deref()) { return Ok(hidden(session, revision)); }
    let branch = work.branch.as_deref().unwrap();
    let key = format!("{}\0{branch}\0{}", std::fs::canonicalize(cwd)?.display(), remote.as_deref().unwrap());
    let fetch = !working && HOSTED.lock().unwrap().entry(key.clone()).or_default().start(mode, Instant::now());
    if fetch {
        let result = (|| {
            anyhow::ensure!(crate::branch_overview::fetch(cwd), "Could not fetch the remote");
            let pr = if mode == Refresh::Remote { github::branch_snapshot_on_demand(cwd, branch)? }
                else { github::branch_snapshot(cwd, branch)? };
            anyhow::ensure!(git::remote_url(cwd) == remote, "The remote changed while refreshing");
            Ok(pr)
        })();
        HOSTED.lock().unwrap().get_mut(&key).unwrap().finish(result, Instant::now());
    }
    let (pr, known) = {
        let cache = HOSTED.lock().unwrap();
        let hosted = cache.get(&key);
        (hosted.and_then(|h| h.pr.clone()), hosted.is_some_and(|h| h.known))
    };
    let after = if fetch {
        let after = read_work(cwd)?;
        if after.branch != work.branch || git::remote_url(cwd) != remote { return Ok(hidden(session, revision)); }
        after
    } else { work };
    compose(session, after, pr, working, known, revision)
}

/// An action re-reads the remote immediately. Only Merge needs the expensive
/// pinned workflow/suite validation; the polling path never runs it.
pub fn read(session: &SessionEntry, working: bool, action: Action) -> Result<Snapshot> {
    let _request = crate::github_process::scope();
    let revision = REVISION.fetch_add(1, Ordering::Relaxed);
    let cwd = checkout(session)?;
    let work = read_work(cwd)?;
    anyhow::ensure!(supported(&work, git::remote_url(cwd).as_deref()), "Git actions need a GitHub feature branch.");
    anyhow::ensure!(!working, "Wait for the agent to finish before running a Git action.");
    let branch = work.branch.as_deref().unwrap();
    anyhow::ensure!(crate::branch_overview::fetch(cwd), "Could not fetch the remote. Check your connection and Git credentials.");
    let mut pr = github::branch_snapshot_on_demand(cwd, branch)?;
    if action == Action::Merge {
        let number = pr.as_ref().context("There is no open pull request.")?.number;
        let evidence = github::pr_snapshot(cwd, number)?;
        anyhow::ensure!(evidence.validation.is_some() && !evidence.checks_unread, "Could not validate the pull request checks. Refresh before merging.");
        pr = Some(evidence);
    }
    let after = read_work(cwd)?;
    anyhow::ensure!(after.branch == work.branch, "The branch changed while refreshing. Refresh again.");
    compose(session, after, pr, working, true, revision)
}

fn compose(session: &SessionEntry, work: WorkStatus, pr: Option<PrSnapshot>, working: bool, known: bool, revision: u64) -> Result<Snapshot> {
    let cwd = Path::new(&session.cwd);
    let base = pr.as_ref().filter(|p| p.state == "OPEN").map(|p| p.base.clone())
        .or_else(|| session.base_ref.as_deref().filter(|s| *s != "HEAD").map(|s| s.strip_prefix("origin/").unwrap_or(s).to_string())
            .filter(|base| git::run(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/origin/{base}")]).is_ok()
                || git::run(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{base}")]).is_ok()))
        .or(work.default_branch.clone()).context("The base branch is unknown.")?;
    let mut work = work;
    if work.default_branch.as_deref() != Some(&base) {
        let remote_base = format!("refs/remotes/origin/{base}");
        let base_ref = if git::run(cwd, &["show-ref", "--verify", "--quiet", &remote_base]).is_ok() { remote_base } else { format!("refs/heads/{base}") };
        work.ahead_of_base = git::run(cwd, &["rev-list", "--count", &format!("{base_ref}..HEAD")]).ok().and_then(|n| n.trim().parse().ok());
    }
    let mut state = resolve(&work, pr.as_ref().filter(|_| known), working);
    // Failed/unfinished hosted reads do not pretend there is no PR or claim
    // readiness. Local steps remain useful even without a network connection.
    if !known && !matches!(state, Step::AgentWorking | Step::Conflicts | Step::Diverged | Step::Behind | Step::Uncommitted | Step::Ahead) {
        state = Step::Hidden;
    }
    if state == Step::NoPr && work.ahead_of_base == Some(0) { state = Step::Hidden; }
    let merge_method = crate::store::projects::issue_pipeline_settings(&session.project_path)?.merge_method;
    let mut available = actions(state, pr.as_ref());
    if !known { available.retain(|action| *action != Action::CreatePr); }
    Ok(Snapshot { revision, session_id: session.id.clone(), cwd: session.cwd.clone(),
        branch: work.branch.context("Check out a branch first.")?, head: work.head.context("This branch has no commits yet.")?, base,
        merge_method, state, actions: available, pr, behind_upstream: work.behind > 0, pull_needs_agent: state == Step::Behind && work.dirty })
}

/// Authorization is held only in this app process, per session, destination,
/// branch and account. Changing accounts/remotes requires a new confirmation.
static CONSENTS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

pub struct RunGuard(String);
impl RunGuard {
    pub fn acquire(cwd: &str) -> Result<Self> {
        let key = std::fs::canonicalize(cwd)?.to_string_lossy().into_owned();
        if !RUNNING.lock().unwrap().insert(key.clone()) { bail!("Another Git action is running in this checkout."); }
        Ok(Self(key))
    }
}
impl Drop for RunGuard { fn drop(&mut self) { RUNNING.lock().unwrap().remove(&self.0); } }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub destination: String,
    pub approved: bool,
}

fn consent_key(session: &SessionEntry, branch: &str, account: &Account) -> String {
    format!("{}\0{}\0{}\0{}\0{}", session.id, session.cwd, branch, account.destination, account.login)
}

fn gh_credential_helper(output: &str, executable: &str) -> bool {
    let mut helpers = Vec::new();
    for line in output.lines() {
        let helper = line.trim();
        if helper.is_empty() { helpers.clear(); } else { helpers.push(helper); }
    }
    if helpers.len() != 1 { return false; }
    let Some(command) = helpers[0].strip_prefix('!').map(str::trim) else { return false; };
    command == "gh auth git-credential" || command == format!("{executable} auth git-credential")
        || command == format!("'{executable}' auth git-credential")
        || command == format!("\"{executable}\" auth git-credential") || command == "\"gh\" auth git-credential"
}

fn ssh_greeting_matches_remote(remote: &str) -> bool {
    // github_identity greets git@host using SSH config. An explicit URL port
    // or a different user would make Git authenticate through another route.
    if remote.starts_with("ssh://") {
        return url::Url::parse(remote).is_ok_and(|url| url.username() == "git" && url.port().is_none());
    }
    remote.starts_with("git@") && crate::github_identity::ssh_host(remote).is_some()
}

pub fn account(session: &SessionEntry, action: Action) -> Result<Account> {
    let _request = crate::github_process::scope();
    let cwd = checkout(session)?;
    let branch = git::current_branch(cwd).context("Check out a branch first.")?;
    let origin = git::remote_url(cwd).context("No origin remote.")?;
    if let Ok(url) = url::Url::parse(&origin) {
        if url.password().is_some() || (url.scheme() == "https" && !url.username().is_empty()) {
            bail!("Move credentials out of the origin URL before using header Git actions.");
        }
    }
    let (login, destination) = if action == Action::Merge {
        let pr = github::prs_for_branch(cwd, &branch)?.into_iter().find(|pr| pr.state == "OPEN").context("There is no open pull request.")?;
        (github::authenticated_login(cwd, &pr.url)?, format!("GitHub API: {}", pr.url))
    } else {
        let remote = git::run(cwd, &["remote", "get-url", "--push", "--all", "origin"])?;
        let urls: Vec<_> = remote.lines().collect();
        if urls.len() != 1 || git::remote_url(cwd).as_deref() != Some(urls[0]) {
            bail!("The origin fetch and push destinations differ. Use the Repo tab to inspect them before pushing.");
        }
        let login = if urls[0].starts_with("https://") {
            let helper = git::run(cwd, &["config", "--get-urlmatch", "credential.helper", urls[0]]).unwrap_or_default();
            let gh = crate::binpath::resolve("gh").context("Install the GitHub CLI first.")?;
            if !gh_credential_helper(&helper, &gh.to_string_lossy()) {
                bail!("The HTTPS push account could not be verified. Configure Git to use gh auth git-credential, or use an SSH remote.");
            }
            github::authenticated_login(cwd, urls[0])?
        } else if crate::github_identity::ssh_host(urls[0]).is_some() {
            if !ssh_greeting_matches_remote(urls[0]) {
                bail!("The SSH push account could not be verified for this URL. Use git@host and configure its port in SSH config.");
            }
            if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some()
                || git::run(cwd, &["config", "--get", "core.sshCommand"]).is_ok() {
                bail!("A custom SSH command controls this checkout's push account. Use the Repo tab, or configure its key in SSH config so the header can verify the account.");
            }
            let identity = crate::github_identity::identity(cwd, true);
            if identity.source.as_deref() != Some("ssh") {
                bail!("Could not verify the GitHub account for this checkout's SSH key. Check your Git credentials.");
            }
            identity.login.filter(|login| !login.is_empty() && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
                .context("Connect a GitHub user account before pushing; a repository deploy key does not identify a user.")?
        } else { bail!("Use an SSH or HTTPS GitHub remote before publishing."); };
        (login, urls[0].to_string())
    };
    let mut account = Account { login, destination, approved: false };
    account.approved = CONSENTS.lock().unwrap().contains(&consent_key(session, &branch, &account));
    Ok(account)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedPr { pub url: String, pub head_sha: String }

/// Identity and the displayed pull route cross back from the UI; fresh
/// evidence decides availability. A click must not silently change into an agent turn.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub session_id: String,
    pub cwd: String,
    pub branch: String,
    pub head: String,
    pub base: String,
    pub merge_method: String,
    pub pr: Option<ExpectedPr>,
    #[serde(default)]
    pub pull_needs_agent: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub action: Action,
    pub expected: Expected,
    pub confirmed_account: Option<Account>,
    pub message: Option<String>,
    pub body: Option<String>,
    pub tab_id: Option<String>,
}

pub enum Outcome { Done(String), Prompt(String) }

fn unchanged(expected: &Expected, now: &Snapshot) -> Result<()> {
    if expected.session_id != now.session_id || expected.cwd != now.cwd || expected.branch != now.branch || expected.head != now.head
        || expected.base != now.base || expected.merge_method != now.merge_method || expected.pull_needs_agent != now.pull_needs_agent
        || expected.pr.as_ref().map(|p| (&p.url, &p.head_sha)) != now.pr.as_ref().map(|p| (&p.url, &p.head_sha)) {
        bail!("The branch or pull request changed. Review its current state and try again.");
    }
    Ok(())
}

fn authorize(session: &SessionEntry, branch: &str, account: &Account, confirmed: Option<&Account>) -> Result<()> {
    if !account.approved {
        if !confirmed.is_some_and(|confirmed| confirmed.login == account.login && confirmed.destination == account.destination) {
            bail!("Confirm publishing as {} before continuing.", account.login);
        }
        CONSENTS.lock().unwrap().insert(consent_key(session, branch, account));
    }
    Ok(())
}

fn transfer(cwd: &Path, args: &[&str]) -> Result<()> {
    git::run_within(cwd, args, Duration::from_secs(120), &|| false)
        .map_err(|error| match error {
            git::RunError::TimedOut => anyhow::anyhow!("Git did not finish within two minutes. Check the connection and refresh before retrying."),
            git::RunError::Stopped => anyhow::anyhow!("Git operation stopped."),
            git::RunError::Failed(message) => anyhow::anyhow!("{message}"),
            git::RunError::Spawn(error) => anyhow::anyhow!("Could not start Git: {error}"),
        })
}

fn check_publish_target(cwd: &Path, branch: &str) -> Result<()> {
    let remote = git::run(cwd, &["config", "--get", &format!("branch.{branch}.remote")]).ok();
    let merge = git::run(cwd, &["config", "--get", &format!("branch.{branch}.merge")]).ok();
    anyhow::ensure!(remote.as_ref().is_none_or(|r| r.trim() == "origin")
        && merge.as_ref().is_none_or(|r| r.trim() == format!("refs/heads/{branch}")),
        "This branch tracks a different remote branch. Use the Branch tab to inspect it before publishing.");
    Ok(())
}

pub fn act(session: &SessionEntry, now: &Snapshot, request: &Request, ensure_idle: impl FnOnce() -> Result<()>) -> Result<Outcome> {
    let _request = crate::github_process::scope();
    unchanged(&request.expected, now)?;
    if !now.actions.contains(&request.action) { bail!("This action is not available in the branch's current state. Refresh and try again."); }
    let cwd = checkout(session)?;
    if request.action.publishes() {
        let account = account(session, request.action)?;
        authorize(session, &now.branch, &account, request.confirmed_account.as_ref())?;
    }
    ensure_idle()?;
    // Account discovery can take time. Check the checkout again before writing.
    let work = read_work(cwd)?;
    if work.branch.as_deref() != Some(&now.branch) || work.head.as_deref() != Some(&now.head) {
        bail!("The checkout moved while preparing the action. Refresh and try again.");
    }
    if !actions(resolve(&work, now.pr.as_ref(), false), now.pr.as_ref()).contains(&request.action) {
        bail!("The working tree changed while preparing the action. Refresh and try again.");
    }
    if request.action == Action::Pull && work.dirty != now.pull_needs_agent {
        bail!("The working tree changed while preparing the pull. Review its current state and try again.");
    }
    if matches!(request.action, Action::CommitPush | Action::Push | Action::CreatePr) {
        check_publish_target(cwd, &now.branch)?;
    }
    let publish = || -> Result<()> {
        let source = format!("refs/heads/{}:refs/heads/{}", now.branch, now.branch);
        transfer(cwd, &["-c", "credential.interactive=false", "push", "--set-upstream", "origin", &source])
    };
    let message = || request.message.as_deref().map(str::trim).filter(|s| !s.is_empty()).context("Enter a message first.");
    let pr = || now.pr.as_ref().filter(|p| p.state == "OPEN").context("There is no open pull request.");
    use Action::*;
    match request.action {
        CommitPush => {
            git::commit_all(cwd, message()?, None)?;
            publish().context("Committed locally, but the push failed. Your commit is safe; refresh to see the next step.")?;
        }
        Push => { publish()?; }
        CreatePr => {
            let title = message()?;
            publish()?;
            let url = github::create_pr(cwd, title, request.body.as_deref().unwrap_or_default(), Some(&now.base), false)?;
            crate::pr_associations::record_local(&session.id, cwd, &url, &now.branch)
                .with_context(|| format!("Created {url}, but could not save its session association"))?;
            return Ok(Outcome::Done(format!("Created {url}")));
        }
        Pull => {
            if work.dirty {
                return Ok(Outcome::Prompt(format!("Pull the latest commits into branch {:?} (base {:?}). Preserve all uncommitted, staged and untracked work; reconcile both sides and resolve conflicts. Do not discard changes, force push, push, merge a pull request or open a new pull request. Report the result.", now.branch, now.base)));
            }
            if now.behind_upstream {
                let target = git::comparison_ref(cwd).context("The remote branch is no longer available. Refresh and try again.")?;
                // read() already fetched. An explicit ref also works for --no-track worktrees.
                git::run(cwd, &["merge", "--ff-only", "--", &target])?;
            } else {
                // GitHub's BEHIND refers to the PR base, not the tracking branch.
                // Background refreshes also fetch. FETCH_HEAD is shared and
                // could name an unrelated branch by the time this read runs.
                let target = format!("refs/remotes/origin/{}", now.base);
                transfer(cwd, &["-c", "credential.interactive=false", "fetch", "--no-tags", "origin", &format!("refs/heads/{}:{target}", now.base)])?;
                let base = git::run(cwd, &["rev-parse", "--verify", &format!("{target}^{{commit}}")])?;
                git::run(cwd, &["merge", "--no-edit", "--", base.trim()])?;
            }
        }
        MarkReady => { github::mark_ready(cwd, pr()?.number)?; }
        Merge => {
            anyhow::ensure!(pr()?.validation.is_some() && !pr()?.checks_unread, "Could not validate the pull request checks. Refresh before merging.");
            match github::merge_pr_at(cwd, pr()?.number, &now.merge_method, &pr()?.head_sha)? {
            github::PinnedMerge::Merged => return Ok(Outcome::Done("Merged".into())),
            github::PinnedMerge::Accepted => return Ok(Outcome::Done("GitHub accepted the merge; awaiting its result.".into())),
            github::PinnedMerge::HeadMoved { .. } => bail!("The pull request head changed. Refresh before merging."),
            github::PinnedMerge::Refused(reason) => bail!("{reason}"),
            }
        },
        ResolveConflicts | FixChecks | AddressReview => {
            let task = match request.action {
                ResolveConflicts => "Reconcile this branch with its upstream and base, and resolve any conflicts while preserving both sides' work. Do not force push.",
                FixChecks => "Inspect the pull request's failing checks, fix their causes and run the relevant checks locally.",
                _ => "Read the pull request's requested changes, address them and run the relevant checks locally.",
            };
            return Ok(Outcome::Prompt(format!("{task}\nBranch: {:?}. Base: {:?}. Pull request: {:?}.\nDo not push, merge a pull request or open a new pull request. Report the changes and any remaining failures.", now.branch, now.base, now.pr.as_ref().map(|p| &p.url))));
        }
    }
    Ok(Outcome::Done("Git action completed.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn ready() -> PrSnapshot {
        // Captured `gh pr list --json ...` (names/URLs anonymized). Overrides
        // below exercise GitHub's documented states in the same CLI shape.
        let mut value: Value = serde_json::from_str(include_str!("fixtures/branch_step_gh.json")).unwrap();
        for (key, value_override) in json!({"state":"OPEN", "isDraft":false, "mergeable":"MERGEABLE", "mergeStateStatus":"CLEAN", "reviewDecision":"APPROVED",
            "statusCheckRollup":[{"name":"test", "status":"COMPLETED", "conclusion":"SUCCESS"}]}).as_object().unwrap() {
            value[key] = value_override.clone();
        }
        let mut pr = github::parse_snapshot(&value);
        pr.validation = Some(vec![]);
        pr
    }

    fn work() -> WorkStatus {
        WorkStatus { is_repo: true, branch: Some("feature".into()), upstream: Some("origin/feature".into()), head: Some("1".repeat(40)), default_branch: Some("main".into()), ..Default::default() }
    }

    #[test]
    fn background_reads_are_local_bounded_and_back_off() {
        let mut hosted = Hosted::default();
        let start = Instant::now();
        assert!(!hosted.start(Refresh::Local, start));
        assert!(hosted.start(Refresh::Auto, start));
        assert!(!hosted.start(Refresh::Remote, start), "coalesce simultaneous callers");
        hosted.finish(Ok(Some(ready())), start);
        for second in 1..300 {
            assert!(!hosted.start(Refresh::Auto, start + Duration::from_secs(second)), "focus must not defeat the interval");
            assert!(!hosted.start(Refresh::Local, start + Duration::from_secs(second)));
        }
        let now = start + REMOTE_EVERY;
        assert!(hosted.start(Refresh::Auto, now));
        hosted.finish(Err(anyhow::anyhow!("rate limited")), now);
        assert!(!hosted.known);
        assert!(!hosted.start(Refresh::Auto, now + REMOTE_EVERY));
        assert!(hosted.start(Refresh::Auto, now + REMOTE_EVERY * 2));
        hosted.finish(Err(anyhow::anyhow!("offline")), now + REMOTE_EVERY * 2);
        assert!(!hosted.start(Refresh::Auto, now + REMOTE_EVERY * 4));
        assert!(hosted.start(Refresh::Remote, now + REMOTE_EVERY * 4), "explicit refresh can retry");
        hosted.finish(Ok(None), now + REMOTE_EVERY * 4);
        assert!(hosted.known);
        assert_eq!(hosted.failures, 0);
        assert!(hosted.start(Refresh::Auto, now + REMOTE_EVERY * 5));
    }

    #[test]
    fn publishing_cannot_silently_switch_the_upstream() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path();
        git::run(cwd, &["init", "-q"]).unwrap();
        assert!(check_publish_target(cwd, "feature").is_ok(), "--no-track branches can publish");
        git::run(cwd, &["config", "branch.feature.remote", "origin"]).unwrap();
        git::run(cwd, &["config", "branch.feature.merge", "refs/heads/feature"]).unwrap();
        assert!(check_publish_target(cwd, "feature").is_ok());
        git::run(cwd, &["config", "branch.feature.merge", "refs/heads/other"]).unwrap();
        assert!(check_publish_target(cwd, "feature").is_err(), "even a missing tracking ref must not change the configured destination");
    }

    #[test]
    fn inapplicable_checkouts_have_no_header_action() {
        assert!(supported(&work(), Some("git@github.com:example/repo.git")));
        assert!(!supported(&WorkStatus { branch: Some("main".into()), ..work() }, Some("git@github.com:example/repo.git")));
        assert!(!supported(&WorkStatus { branch: None, ..work() }, Some("git@github.com:example/repo.git")));
        for remote in [None, Some("git@gitlab.com:example/repo.git"), Some("/local/repo.git")] {
            assert!(!supported(&work(), remote));
        }
        assert!(hidden(&session(), 1).actions.is_empty());
    }

    #[test]
    fn offline_status_keeps_local_steps_and_empty_branches_stay_hidden() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = crate::store::projects::ensure(dir.path().to_str().unwrap()).unwrap();
        let session = SessionEntry { cwd: project.path.clone(), project_path: project.path, ..session() };
        let empty = WorkStatus { ahead_of_base: Some(0), ..work() };
        assert_eq!(compose(&session, empty, None, false, true, 1).unwrap().state, Step::Hidden);
        let offline = compose(&session, WorkStatus { dirty: true, ..work() }, Some(ready()), false, false, 2).unwrap();
        assert_eq!(offline.state, Step::Uncommitted);
        assert_eq!(offline.actions, vec![Action::CommitPush]);
        assert_eq!(compose(&session, work(), Some(ready()), false, false, 3).unwrap().state, Step::Hidden, "stale hosted readiness is not shown after a failed read");
    }

    #[test]
    fn every_state_from_git_porcelain_counts_and_gh_records() {
        let records: Vec<Value> = serde_json::from_str(include_str!("fixtures/branch_step_cases.json")).unwrap();
        assert_eq!(records.len(), 16);
        for record in records {
            let porcelain = record["porcelain"].as_str().unwrap();
            let (ahead, behind) = git::parse_upstream_counts(record["counts"].as_str().unwrap()).unwrap();
            let work = WorkStatus { dirty: !porcelain.is_empty(), conflicted: git::unmerged_in(porcelain), ahead, behind, ..work() };
            let pr = record["pr"].as_object().map(|patch| {
                let mut pr = ready();
                let mut raw: Value = serde_json::from_str(include_str!("fixtures/branch_step_gh.json")).unwrap();
                raw["state"] = json!("OPEN"); raw["isDraft"] = json!(false); raw["mergeable"] = json!("MERGEABLE");
                raw["mergeStateStatus"] = json!("CLEAN"); raw["reviewDecision"] = json!("APPROVED");
                raw["statusCheckRollup"] = json!([{"name":"test", "status":"COMPLETED", "conclusion":"SUCCESS"}]);
                for (key, value) in patch { raw[key] = value.clone(); }
                let parsed = github::parse_snapshot(&raw);
                pr = PrSnapshot { validation: pr.validation, ..parsed };
                pr
            });
            let expected: Step = serde_json::from_value(record["expected"].clone()).unwrap();
            assert_eq!(resolve(&work, pr.as_ref(), record["working"].as_bool().unwrap()), expected, "{record}");
        }
    }

    #[test]
    fn unread_stale_missing_unknown_or_pending_evidence_never_merges() {
        for kind in ["unread", "head", "required", "unknown", "queued", "blocked", "optionalFailure", "behind", "conflicting"] {
            let mut pr = ready();
            match kind {
                "unread" => pr.checks_unread = true,
                "head" => pr.head_sha = "2".repeat(40),
                "required" => pr.required_checks = Some(vec!["missing".into()]),
                "unknown" => pr.checks[0].state = "future_status".into(),
                "queued" => pr.validation = Some(vec![github::PrCheck { name: "workflow".into(), state: "queued".into(), url: None, actions: None, ..Default::default() }]),
                "blocked" => pr.merge_state = "BLOCKED".into(),
                "optionalFailure" => { pr.required_checks = Some(vec!["test".into()]); pr.validation = Some(vec![github::PrCheck { name: "optional".into(), state: "failure".into(), url: None, actions: None, ..Default::default() }]); }
                "behind" => pr.merge_state = "BEHIND".into(),
                "conflicting" => pr.mergeable = "CONFLICTING".into(),
                _ => unreachable!(),
            }
            let state = resolve(&work(), Some(&pr), false);
            assert_ne!(state, Step::Ready, "{kind}");
            assert!(!actions(state, Some(&pr)).contains(&Action::Merge), "{kind}");
        }
    }

    #[test]
    fn local_work_precedes_hosted_readiness_and_new_work_is_not_already_merged() {
        let pr = ready();
        assert_eq!(resolve(&WorkStatus { dirty: true, behind: 2, ..work() }, Some(&pr), false), Step::Behind);
        assert_eq!(resolve(&WorkStatus { dirty: true, conflicted: vec!["src/a".into()], ..work() }, Some(&pr), false), Step::Conflicts);
        assert_eq!(resolve(&WorkStatus { operation: Some("rebase".into()), ..work() }, Some(&pr), false), Step::Conflicts);
        for remote_state in ["BEHIND", "DIRTY"] {
            let mut old = pr.clone();
            old.merge_state = remote_state.into();
            let committed_resolution = WorkStatus { ahead: 1, head: Some("2".repeat(40)), ..work() };
            assert_eq!(resolve(&committed_resolution, Some(&old), false), Step::Ahead);
        }
        let mut merged = pr;
        merged.state = "MERGED".into();
        assert_eq!(resolve(&WorkStatus { head: Some("2".repeat(40)), ..work() }, Some(&merged), false), Step::NoPr);
        merged.state = "CLOSED".into();
        assert_eq!(resolve(&work(), Some(&merged), false), Step::NoPr);
    }

    #[test]
    fn the_menu_keeps_applicable_actions_beside_the_primary_step() {
        let mut pr = ready();
        pr.is_draft = true;
        pr.checks[0].state = "failure".into();
        assert_eq!(actions(resolve(&work(), Some(&pr), false), Some(&pr)), vec![Action::MarkReady, Action::FixChecks]);
        pr.review_decision = Some("CHANGES_REQUESTED".into());
        assert_eq!(actions(resolve(&work(), Some(&pr), false), Some(&pr)), vec![Action::AddressReview, Action::MarkReady, Action::FixChecks]);
    }

    fn session() -> SessionEntry {
        serde_json::from_value(json!({"id":"branch-step-test", "cwd":"/repo", "projectPath":"/repo", "title":"Test", "created":"", "modified":""})).unwrap()
    }

    fn snapshot() -> Snapshot {
        Snapshot { revision: 1, session_id: "branch-step-test".into(), cwd: "/repo".into(), branch: "feature".into(), head: "1".repeat(40), base: "main".into(), merge_method: "merge".into(),
            state: Step::Ready, actions: vec![Action::Merge], pr: Some(ready()), behind_upstream: false, pull_needs_agent: false }
    }

    #[test]
    fn a_click_cannot_follow_a_changed_branch_head_base_repo_or_merge_method() {
        let before: Expected = serde_json::from_value(serde_json::to_value(snapshot()).unwrap()).unwrap();
        assert!(unchanged(&before, &snapshot()).is_ok());
        for changed in ["session", "cwd", "branch", "head", "base", "method", "pr", "prHead", "pullRoute"] {
            let mut now = snapshot();
            match changed {
                "session" => now.session_id = "other".into(), "cwd" => now.cwd = "/other".into(), "branch" => now.branch = "other".into(),
                "head" => now.head = "2".repeat(40), "base" => now.base = "release".into(), "method" => now.merge_method = "squash".into(),
                "pr" => now.pr.as_mut().unwrap().url = "https://github.com/other/repo/pull/7".into(), "prHead" => now.pr.as_mut().unwrap().head_sha = "2".repeat(40), "pullRoute" => now.pull_needs_agent = true, _ => unreachable!(),
            }
            assert!(unchanged(&before, &now).is_err(), "{changed}");
        }
    }

    #[test]
    fn publishing_requires_the_named_account_and_is_remembered_only_for_that_session_and_destination() {
        let session = session();
        let account = Account { login: "alice".into(), destination: "git@github.com:example/repo.git".into(), approved: false };
        assert!(authorize(&session, "feature", &account, None).is_err());
        assert!(authorize(&session, "feature", &account, Some(&Account { login: "bob".into(), ..account.clone() })).is_err());
        authorize(&session, "feature", &account, Some(&account)).unwrap();
        assert!(CONSENTS.lock().unwrap().contains(&consent_key(&session, "feature", &account)));
        assert!(!CONSENTS.lock().unwrap().contains(&consent_key(&SessionEntry { id: "other".into(), ..session.clone() }, "feature", &account)));
        assert!(!CONSENTS.lock().unwrap().contains(&consent_key(&session, "other-branch", &account)));
        assert!(!CONSENTS.lock().unwrap().contains(&consent_key(&session, "feature", &Account { destination: "different".into(), ..account.clone() })));
        authorize(&session, "feature", &Account { approved: true, ..account }, None).unwrap();
    }

    #[test]
    fn a_checkout_allows_only_one_action_and_releases_after_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let first = RunGuard::acquire(path).unwrap();
        assert!(RunGuard::acquire(path).is_err());
        drop(first);
        assert!(RunGuard::acquire(path).is_ok());
    }

    #[test]
    fn github_identity_requires_one_exact_credential_helper() {
        let gh = "/opt/homebrew/bin/gh";
        assert!(gh_credential_helper("!gh auth git-credential\n", gh));
        assert!(gh_credential_helper("!\"gh\" auth git-credential\n", gh));
        assert!(gh_credential_helper("!\"/opt/homebrew/bin/gh\" auth git-credential\n", gh));
        assert!(gh_credential_helper("\n!/opt/homebrew/bin/gh auth git-credential\n", gh));
        assert!(gh_credential_helper("osxkeychain\n\n!'/opt/homebrew/bin/gh' auth git-credential\n", gh));
        for unsafe_helper in ["osxkeychain", "!echo gh auth git-credential", "!gh auth git-credential; echo other", "!gh auth git-credential\nosxkeychain", "!/other/gh auth git-credential"] {
            assert!(!gh_credential_helper(unsafe_helper, gh), "{unsafe_helper}");
        }
    }

    #[test]
    fn ssh_confirmation_must_use_the_same_user_and_port_as_the_push() {
        for remote in ["git@github.com:example/repo.git", "git@github-work:example/repo.git", "ssh://git@github.com/example/repo.git"] {
            assert!(ssh_greeting_matches_remote(remote), "{remote}");
        }
        for remote in ["ssh://git@github.com:443/example/repo.git", "ssh://other@github.com/example/repo.git", "other@github.com:example/repo.git", "github.com:example/repo.git"] {
            assert!(!ssh_greeting_matches_remote(remote), "{remote}");
        }
    }

    #[test]
    fn real_checkout_advances_after_commit_push_fetch_and_conflict() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("work");
        let remote = root.path().join("remote.git");
        let other = root.path().join("other");
        std::fs::create_dir(&cwd).unwrap();
        git::run(&cwd, &["init", "--initial-branch=main"]).unwrap();
        let configure = |path: &Path| {
            git::run(path, &["config", "user.name", "Test"]).unwrap();
            git::run(path, &["config", "user.email", "test@example.com"]).unwrap();
            git::run(path, &["config", "commit.gpgsign", "false"]).unwrap();
        };
        configure(&cwd);
        std::fs::write(cwd.join("file"), "base\n").unwrap();
        git::commit_all(&cwd, "Base", None).unwrap();
        git::run(root.path(), &["init", "--bare", "--initial-branch=main", remote.to_str().unwrap()]).unwrap();
        git::run(&cwd, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        git::run(&cwd, &["push", "-u", "origin", "main"]).unwrap();
        git::run(&cwd, &["checkout", "-b", "feature"]).unwrap();
        git::run(&cwd, &["push", "-u", "origin", "feature"]).unwrap();
        assert_eq!(resolve(&git::work_status(&cwd), None, false), Step::NoPr);
        std::fs::write(cwd.join("file"), "first\n").unwrap();
        assert_eq!(resolve(&git::work_status(&cwd), None, false), Step::Uncommitted);
        git::commit_all(&cwd, "First", None).unwrap();
        assert_eq!(resolve(&git::work_status(&cwd), None, false), Step::Ahead);
        git::run(&cwd, &["push"]).unwrap();
        let mut pr = ready();
        pr.head_sha = git::head_commit(&cwd).unwrap();
        // A local branch that happens to look like a remote ref cannot alter the counts.
        git::run(&cwd, &["branch", "origin/feature", "main"]).unwrap();
        assert_eq!(git::comparison_ref(&cwd).as_deref(), Some("refs/remotes/origin/feature"));
        assert_eq!(resolve(&read_work(&cwd).unwrap(), Some(&pr), false), Step::Ready);
        git::run(&cwd, &["branch", "--unset-upstream"]).unwrap();
        assert!(git::work_status(&cwd).upstream.is_none());
        assert_eq!(resolve(&read_work(&cwd).unwrap(), Some(&pr), false), Step::Ready);
        git::run(&cwd, &["branch", "-D", "origin/feature"]).unwrap();
        git::run(root.path(), &["clone", "--branch", "feature", remote.to_str().unwrap(), other.to_str().unwrap()]).unwrap();
        configure(&other);
        // GitHub's BEHIND can mean the PR base advanced even though our
        // tracking branch has no incoming commits. Exercise the actual action.
        git::run(&other, &["checkout", "main"]).unwrap();
        std::fs::write(other.join("base-file"), "new base content\n").unwrap();
        git::commit_all(&other, "Advance base", None).unwrap();
        git::run(&other, &["push", "origin", "main"]).unwrap();
        pr.merge_state = "BEHIND".into();
        let session = SessionEntry { cwd: cwd.to_string_lossy().into_owned(), ..session() };
        let now = Snapshot { cwd: session.cwd.clone(), head: pr.head_sha.clone(), state: Step::Behind, actions: vec![Action::Pull], pr: Some(pr.clone()), ..snapshot() };
        let request = Request { action: Action::Pull, expected: serde_json::from_value(serde_json::to_value(&now).unwrap()).unwrap(), confirmed_account: None, message: None, body: None, tab_id: None };
        assert!(matches!(act(&session, &now, &request, || Ok(())).unwrap(), Outcome::Done(_)));
        assert_eq!(std::fs::read_to_string(cwd.join("base-file")).unwrap(), "new base content\n");
        assert_eq!(resolve(&git::work_status(&cwd), None, false), Step::Ahead);
        git::run(&cwd, &["push", "origin", "HEAD"]).unwrap();
        git::run(&other, &["checkout", "feature"]).unwrap();
        git::run(&other, &["pull", "--ff-only"]).unwrap();
        pr.head_sha = git::head_commit(&cwd).unwrap();
        pr.merge_state = "CLEAN".into();
        std::fs::write(other.join("file"), "theirs\n").unwrap();
        git::commit_all(&other, "Other", None).unwrap();
        git::run(&other, &["push"]).unwrap();
        git::run(&cwd, &["fetch", "origin"]).unwrap();
        assert_eq!(resolve(&read_work(&cwd).unwrap(), Some(&pr), false), Step::Behind);
        let before_pull = git::head_commit(&cwd).unwrap();
        let incoming = Snapshot { head: before_pull.clone(), state: Step::Behind, actions: vec![Action::Pull], pr: Some(pr.clone()), behind_upstream: true, ..now.clone() };
        let pull = Request { expected: serde_json::from_value(serde_json::to_value(&incoming).unwrap()).unwrap(), action: Action::Pull, confirmed_account: None, message: None, body: None, tab_id: None };
        assert!(matches!(act(&session, &incoming, &pull, || Ok(())).unwrap(), Outcome::Done(_)));
        assert_eq!(git::head_commit(&cwd), git::head_commit(&other), "a no-track checkout pulls the published branch");
        assert!(git::work_status(&cwd).upstream.is_none(), "pull does not rewrite tracking configuration");
        git::run(&cwd, &["reset", "--hard", &before_pull]).unwrap();
        git::pull(&cwd).unwrap();
        assert_eq!(git::head_commit(&cwd), git::head_commit(&other), "the Branch tab can pull the same no-track checkout");
        assert!(git::work_status(&cwd).upstream.is_none());
        // Rewind this disposable test checkout to exercise dirty incoming work.
        git::run(&cwd, &["reset", "--hard", &before_pull]).unwrap();
        std::fs::write(cwd.join("file"), "ours\n").unwrap();
        let dirty = read_work(&cwd).unwrap();
        assert_eq!(resolve(&dirty, Some(&pr), false), Step::Behind);
        assert!(act(&session, &incoming, &pull, || Ok(())).err().unwrap().to_string().contains("working tree changed"));
        let dirty_snapshot = Snapshot { head: dirty.head.clone().unwrap(), state: Step::Behind, actions: vec![Action::Pull], pr: Some(pr.clone()), behind_upstream: true, pull_needs_agent: true, ..now.clone() };
        let dirty_request = Request { expected: serde_json::from_value(serde_json::to_value(&dirty_snapshot).unwrap()).unwrap(), action: Action::Pull, confirmed_account: None, message: None, body: None, tab_id: None };
        assert!(matches!(act(&session, &dirty_snapshot, &dirty_request, || Ok(())).unwrap(), Outcome::Prompt(_)));
        assert_eq!(std::fs::read_to_string(cwd.join("file")).unwrap(), "ours\n");
        assert_eq!(git::head_commit(&cwd), dirty.head, "asking to reconcile must not commit or push");
        git::commit_all(&cwd, "Ours", None).unwrap();
        assert_eq!(resolve(&git::work_status(&cwd), Some(&pr), false), Step::Diverged);
        assert!(git::run(&cwd, &["merge", "origin/feature"]).is_err());
        assert_eq!(resolve(&git::work_status(&cwd), Some(&pr), false), Step::Conflicts);
        git::run(&cwd, &["merge", "--abort"]).unwrap();
        assert!(git::run(&cwd, &["rebase", "origin/feature"]).is_err());
        assert!(git::current_branch(&cwd).is_none());
        let work = read_work(&cwd).unwrap();
        assert_eq!(work.branch.as_deref(), Some("feature"));
        assert_eq!(resolve(&work, None, false), Step::Conflicts);
        let now = Snapshot { head: work.head.unwrap(), state: Step::Conflicts, actions: vec![Action::ResolveConflicts], pr: None, ..now };
        let request = Request { action: Action::ResolveConflicts, expected: serde_json::from_value(serde_json::to_value(&now).unwrap()).unwrap(), ..request };
        assert!(matches!(act(&session, &now, &request, || Ok(())).unwrap(), Outcome::Prompt(_)));
        git::run(&cwd, &["rebase", "--abort"]).unwrap();
    }

}
