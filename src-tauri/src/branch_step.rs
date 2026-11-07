//! The session header's next Git step. Reads are published after one complete
//! refresh; actions re-read their inputs and never force push or bypass GitHub rules.
use std::{collections::HashSet, path::Path, sync::{atomic::{AtomicU64, Ordering}, LazyLock, Mutex}, time::Duration};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::{git::{self, WorkStatus}, github::{self, PrSnapshot}, issue_pipeline::gate::{check_bucket, CheckBucket}, store::index::SessionEntry};

pub const EVENT: &str = "branch_step_changed";
static REVISION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    NoPr, AgentWorking, Uncommitted, Behind, Ahead, Diverged, Conflicts,
    ChangesRequested, Draft, ChecksFailing, ChecksPending, ReviewRequired, Ready, Merged,
}

/// Local work takes precedence over hosted readiness. Unknown check conclusions
/// and unpublished requirements cannot turn into an enabled Merge button.
pub fn resolve(work: &WorkStatus, pr: Option<&PrSnapshot>, working: bool) -> Step {
    if working { return Step::AgentWorking; }
    if !work.conflicted.is_empty() || work.operation.is_some() { return Step::Conflicts; }
    if work.dirty { return Step::Uncommitted; }
    if work.ahead > 0 && work.behind > 0 { return Step::Diverged; }
    if work.behind > 0 { return Step::Behind; }
    if work.ahead > 0 { return Step::Ahead; }
    let Some(pr) = pr else { return Step::NoPr; };
    if pr.state == "MERGED" {
        return if work.head.as_deref() == Some(&pr.head_sha) { Step::Merged } else { Step::NoPr };
    }
    if pr.state != "OPEN" { return Step::NoPr; }
    if pr.mergeable == "CONFLICTING" || pr.merge_state == "DIRTY" { return Step::Conflicts; }
    if pr.merge_state == "BEHIND" { return Step::Behind; }
    if pr.review_decision.as_deref() == Some("CHANGES_REQUESTED") { return Step::ChangesRequested; }
    if pr.is_draft { return Step::Draft; }
    if pr.checks_unread || pr.validation.is_none() || work.head.as_deref() != Some(&pr.head_sha) { return Step::ChecksPending; }
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
}

fn actions(step: Step, pr: Option<&PrSnapshot>) -> Vec<Action> {
    use Action::*;
    let mut available = match step {
        Step::AgentWorking | Step::Merged => vec![],
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
    Ok(work)
}

pub fn read(session: &SessionEntry, working: bool) -> Result<Snapshot> {
    let revision = REVISION.fetch_add(1, Ordering::Relaxed);
    let cwd = checkout(session)?;
    let mut work = read_work(cwd)?;
    let branch = work.branch.clone().context("Check out a branch to use Git actions.")?;
    if work.branch == work.default_branch { bail!("Create a worktree branch before opening a pull request."); }
    let remote = git::remote_url(cwd).context("Add a GitHub origin remote to use Git actions.")?;
    if crate::github_identity::remote_host_kind(&remote) != "github" { bail!("The header's pull request actions need a GitHub remote."); }
    let pr = if working || work.operation.is_some() || !work.conflicted.is_empty() { None } else {
        if !crate::branch_overview::fetch(cwd) { bail!("Could not fetch the remote. Check your connection and Git credentials, then refresh."); }
        if git::current_branch(cwd).as_deref() != Some(&branch) { bail!("The branch changed while refreshing. Refresh again."); }
        let prs = github::prs_for_branch(cwd, &branch)?;
        match prs.first() {
            Some(pr) => Some(github::pr_snapshot(cwd, pr.number)?),
            None => None,
        }
    };
    // Do not combine a hosted snapshot with local work read before a commit.
    let after = read_work(cwd)?;
    if after.branch.as_deref() != Some(&branch) { bail!("The branch changed while refreshing. Refresh again."); }
    work = after;
    let state = resolve(&work, pr.as_ref(), working);
    let base = pr.as_ref().filter(|p| p.state == "OPEN").map(|p| p.base.clone())
        .or_else(|| session.base_ref.as_deref().filter(|s| *s != "HEAD").map(|s| s.strip_prefix("origin/").unwrap_or(s).to_string())
            .filter(|base| git::run(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/origin/{base}")]).is_ok()
                || git::run(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{base}")]).is_ok()))
        .or(work.default_branch.clone()).context("The base branch is unknown.")?;
    let merge_method = crate::store::projects::issue_pipeline_settings(&session.project_path)?.merge_method;
    Ok(Snapshot { revision, session_id: session.id.clone(), cwd: session.cwd.clone(), branch, head: work.head.context("This branch has no commits yet.")?, base,
        merge_method, state, actions: actions(state, pr.as_ref()), pr, behind_upstream: work.behind > 0 })
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

/// Only identity crosses back from the UI; fresh evidence decides the action.
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
        || expected.base != now.base || expected.merge_method != now.merge_method
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

pub fn act(session: &SessionEntry, now: &Snapshot, request: &Request, ensure_idle: impl FnOnce() -> Result<()>) -> Result<Outcome> {
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
            publish().context("Committed locally, but the push failed. Your commit is safe; retry with Push.")?;
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
            if now.behind_upstream {
                transfer(cwd, &["-c", "credential.interactive=false", "pull", "--ff-only"])?;
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
        Merge => match github::merge_pr_at(cwd, pr()?.number, &now.merge_method, &pr()?.head_sha)? {
            github::PinnedMerge::Merged => return Ok(Outcome::Done("Merged".into())),
            github::PinnedMerge::Accepted => return Ok(Outcome::Done("GitHub accepted the merge; awaiting its result.".into())),
            github::PinnedMerge::HeadMoved { .. } => bail!("The pull request head changed. Refresh before merging."),
            github::PinnedMerge::Refused(reason) => bail!("{reason}"),
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
    fn every_state_from_git_porcelain_counts_and_gh_records() {
        let records: Vec<Value> = serde_json::from_str(include_str!("fixtures/branch_step_cases.json")).unwrap();
        assert_eq!(records.len(), 14);
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
        for kind in ["unread", "head", "validation", "required", "unknown", "queued", "blocked", "optionalFailure", "behind", "conflicting"] {
            let mut pr = ready();
            match kind {
                "unread" => pr.checks_unread = true,
                "head" => pr.head_sha = "2".repeat(40),
                "validation" => pr.validation = None,
                "required" => pr.required_checks = Some(vec!["missing".into()]),
                "unknown" => pr.checks[0].state = "future_status".into(),
                "queued" => pr.validation = Some(vec![github::PrCheck { name: "workflow".into(), state: "queued".into(), url: None }]),
                "blocked" => pr.merge_state = "BLOCKED".into(),
                "optionalFailure" => { pr.required_checks = Some(vec!["test".into()]); pr.validation = Some(vec![github::PrCheck { name: "optional".into(), state: "failure".into(), url: None }]); }
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
        assert_eq!(resolve(&WorkStatus { dirty: true, behind: 2, ..work() }, Some(&pr), false), Step::Uncommitted);
        assert_eq!(resolve(&WorkStatus { dirty: true, conflicted: vec!["src/a".into()], ..work() }, Some(&pr), false), Step::Conflicts);
        assert_eq!(resolve(&WorkStatus { operation: Some("rebase".into()), ..work() }, Some(&pr), false), Step::Conflicts);
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
            state: Step::Ready, actions: vec![Action::Merge], pr: Some(ready()), behind_upstream: false }
    }

    #[test]
    fn a_click_cannot_follow_a_changed_branch_head_base_repo_or_merge_method() {
        let before: Expected = serde_json::from_value(serde_json::to_value(snapshot()).unwrap()).unwrap();
        assert!(unchanged(&before, &snapshot()).is_ok());
        for changed in ["session", "cwd", "branch", "head", "base", "method", "pr", "prHead"] {
            let mut now = snapshot();
            match changed {
                "session" => now.session_id = "other".into(), "cwd" => now.cwd = "/other".into(), "branch" => now.branch = "other".into(),
                "head" => now.head = "2".repeat(40), "base" => now.base = "release".into(), "method" => now.merge_method = "squash".into(),
                "pr" => now.pr.as_mut().unwrap().url = "https://github.com/other/repo/pull/7".into(), "prHead" => now.pr.as_mut().unwrap().head_sha = "2".repeat(40), _ => unreachable!(),
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
        assert_eq!(resolve(&git::work_status(&cwd), Some(&pr), false), Step::Ready);
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
        git::run(&cwd, &["push"]).unwrap();
        git::run(&other, &["checkout", "feature"]).unwrap();
        git::run(&other, &["pull", "--ff-only"]).unwrap();
        pr.head_sha = git::head_commit(&cwd).unwrap();
        pr.merge_state = "CLEAN".into();
        std::fs::write(other.join("file"), "theirs\n").unwrap();
        git::commit_all(&other, "Other", None).unwrap();
        git::run(&other, &["push"]).unwrap();
        git::run(&cwd, &["fetch", "origin"]).unwrap();
        assert_eq!(resolve(&git::work_status(&cwd), Some(&pr), false), Step::Behind);
        std::fs::write(cwd.join("file"), "ours\n").unwrap();
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
