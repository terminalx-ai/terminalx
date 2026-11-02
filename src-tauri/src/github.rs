//! Pull requests through the `gh` CLI, which already holds auth and host
//! configuration. Absent `gh` is one readable line, not a broken panel.

use std::path::{Path, PathBuf};
use std::collections::BTreeSet;
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn gh() -> Result<Command> {
    let p = crate::binpath::resolve("gh").ok_or_else(|| anyhow!("GitHub CLI (gh) is not installed or not on PATH."))?;
    let mut c = Command::new(p);
    c.env("PATH", crate::binpath::login_path());
    c.env("GH_PROMPT_DISABLED", "1");
    c.env("NO_COLOR", "1");
    Ok(c)
}

/// How long one `gh` call may take. Without a limit, a call that hangs on the
/// network would hold whatever is waiting on it for good: a panel, or the
/// issue pipeline's step and its poller.
const GH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

fn read_all(pipe: Option<impl std::io::Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

/// `Command::output`, with a deadline after which the process is killed.
fn output_within(mut command: Command, timeout: std::time::Duration) -> Result<std::process::Output> {
    use std::process::Stdio;
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    // Read as it comes, so a full pipe never blocks gh.
    let (stdout, stderr) = (read_all(child.stdout.take()), read_all(child.stderr.take()));
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                bail!("GitHub did not answer within {} seconds.", timeout.as_secs());
            }
            None => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    };
    Ok(std::process::Output { status, stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() })
}

fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let mut command = gh()?;
    command.current_dir(cwd).args(args);
    let out = output_within(command, GH_TIMEOUT).with_context(|| format!("gh {}", args.join(" ")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!("{}", if err.is_empty() { format!("gh {} failed", args.join(" ")) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    /// `success`, `failure`, `pending`, `cancelled`, `skipped`, ...
    pub state: String,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// OPEN | MERGED | CLOSED
    pub state: String,
    pub is_draft: bool,
    pub base: String,
    pub head: String,
    pub additions: u64,
    pub deletions: u64,
    /// MERGEABLE | CONFLICTING | UNKNOWN
    pub mergeable: String,
    pub review_decision: Option<String>,
    pub checks: Vec<PrCheck>,
    pub body: String,
    pub author: String,
}

pub(crate) const FIELDS: &str = "number,title,url,state,isDraft,baseRefName,headRefName,additions,deletions,mergeable,reviewDecision,statusCheckRollup,body,author";

pub(crate) fn parse_pr(v: &Value) -> PullRequest {
    let checks = v["statusCheckRollup"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| {
                    let name = c["name"].as_str().or_else(|| c["context"].as_str()).unwrap_or("check").to_string();
                    let state = match c["status"].as_str() {
                        Some(status) if !status.eq_ignore_ascii_case("completed") => status,
                        _ => c["conclusion"].as_str().filter(|s| !s.is_empty()).or_else(|| c["state"].as_str()).unwrap_or("pending"),
                    }
                    .to_ascii_lowercase();
                    PrCheck { name, state, url: c["detailsUrl"].as_str().or_else(|| c["targetUrl"].as_str()).map(String::from) }
                })
                .collect()
        })
        .unwrap_or_default();
    PullRequest {
        number: v["number"].as_u64().unwrap_or(0),
        title: v["title"].as_str().unwrap_or("").into(),
        url: v["url"].as_str().unwrap_or("").into(),
        state: v["state"].as_str().unwrap_or("OPEN").into(),
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
        base: v["baseRefName"].as_str().unwrap_or("").into(),
        head: v["headRefName"].as_str().unwrap_or("").into(),
        additions: v["additions"].as_u64().unwrap_or(0),
        deletions: v["deletions"].as_u64().unwrap_or(0),
        mergeable: v["mergeable"].as_str().unwrap_or("UNKNOWN").into(),
        review_decision: v["reviewDecision"].as_str().filter(|s| !s.is_empty()).map(String::from),
        checks,
        body: v["body"].as_str().unwrap_or("").into(),
        author: v["author"]["login"].as_str().unwrap_or("").into(),
    }
}

/// `gh pr list` with the given flags (a `--json` among them), as its records.
pub fn list_prs(cwd: &Path, flags: &[&str]) -> Result<Vec<Value>> {
    let mut args = vec!["pr", "list"];
    args.extend_from_slice(flags);
    let out = run(cwd, &args)?;
    Ok(serde_json::from_str::<Value>(&out)?.as_array().cloned().unwrap_or_default())
}

/// Every PR whose head is `branch`, open first then newest.
pub fn prs_for_branch(cwd: &Path, branch: &str) -> Result<Vec<PullRequest>> {
    prs_for_branch_with(cwd, branch, run)
}

fn prs_for_branch_with(cwd: &Path, branch: &str, run: impl FnOnce(&Path, &[&str]) -> Result<String>) -> Result<Vec<PullRequest>> {
    let fields = format!("{FIELDS},isCrossRepository,headRepository,headRepositoryOwner");
    let out = run(cwd, &["pr", "list", "--head", branch, "--state", "all", "--json", &fields, "--limit", "1000"])?;
    let v: Value = serde_json::from_str(&out)?;
    let origin = crate::git::remote_url(cwd).as_deref().and_then(crate::issues::github_repo_from_url);
    let mut prs: Vec<PullRequest> = v.as_array().map(|a| a.iter().filter(|pr| {
        // Another fork can reuse the same branch name. Only explicit identity
        // associations may bring in a PR whose head repository isn't ours.
        pr["isCrossRepository"].as_bool() != Some(true) || origin.as_ref().is_some_and(|origin| {
            let owner = pr["headRepositoryOwner"]["login"].as_str().unwrap_or_default();
            let repo = pr["headRepository"]["name"].as_str().unwrap_or_default();
            origin.eq_ignore_ascii_case(&format!("{owner}/{repo}"))
        })
    }).map(parse_pr).collect()).unwrap_or_default();
    prs.sort_by(|a, b| (b.state == "OPEN").cmp(&(a.state == "OPEN")).then(b.number.cmp(&a.number)));
    // Lookup is also used by workspace deletion checks, and runs while Stats
    // is closed. Only known workspaces/branches contribute installation totals.
    let recorded = (|| -> Result<()> {
        if tracked_pr_branches()?.contains(&(canonical_path(cwd), branch.to_string())) {
            for pr in &prs { crate::stats::record_pr(&pr.url)?; }
        }
        Ok(())
    })();
    if let Err(error) = recorded {
        log::warn!("record discovered PRs: {error:#}");
        crate::store::activity::report_error(format!("PRs were discovered, but their activity could not be saved: {error:#}"));
    }
    Ok(prs)
}

fn canonical_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn tracked_pr_branches() -> Result<BTreeSet<(PathBuf, String)>> {
    let mut branches = BTreeSet::new();
    for session in crate::store::index::load()? {
        if let Some(branch) = session.branch {
            let cwd = if Path::new(&session.cwd).exists() { &session.cwd } else { &session.project_path };
            branches.insert((canonical_path(Path::new(cwd)), branch));
        }
        if let Some(removed) = session.removed_workspace {
            if let Some(branch) = removed.branch {
                branches.insert((canonical_path(Path::new(&session.project_path)), branch));
            }
        }
    }
    for project in crate::store::projects::list()?.0 {
        let path = Path::new(&project.path);
        if !path.exists() { continue; }
        if let Ok(worktrees) = crate::git::list_worktrees(path) {
            for (path, branch) in worktrees {
                if let Some(branch) = branch {
                    let cwd = if Path::new(&path).exists() { Path::new(&path) } else { Path::new(&project.path) };
                    branches.insert((canonical_path(cwd), branch));
                }
            }
        }
    }
    Ok(branches)
}

/// Repeatable startup discovery, including retained archived/removed branches.
/// No account-wide PR search and no dependence on opening the PR/Stats panels.
pub fn recover_workspace_prs() -> Result<()> {
    let mut errors = Vec::new();
    for (cwd, branch) in tracked_pr_branches()? {
        if let Err(error) = prs_for_branch(&cwd, &branch) {
            errors.push(format!("{} ({branch}): {error:#}", cwd.display()));
        }
    }
    if !errors.is_empty() { bail!("{}", errors.join("; ")); }
    Ok(())
}

/// One pull request by number, for command-palette task URLs.
pub fn pr_details(cwd: &Path, number: u64) -> Result<PullRequest> {
    let out = run(cwd, &["pr", "view", &number.to_string(), "--json", FIELDS])?;
    let value: Value = serde_json::from_str(&out)?;
    Ok(parse_pr(&value))
}

/// An associated PR is addressed by its full identity, not a number in the
/// currently selected repository. Use gh's host routing from the URL.
fn associated_target(number: u64, url: Option<&str>) -> Result<String> {
    let Some(url) = url else { return Ok(number.to_string()); };
    let identity = crate::pr_associations::identity(url)?;
    if identity.rsplit('/').next().and_then(|n| n.parse::<u64>().ok()) != Some(number) {
        bail!("Pull request number does not match its URL");
    }
    Ok(identity)
}

pub fn associated_pr_details(cwd: &Path, number: u64, url: Option<&str>) -> Result<PullRequest> {
    if url.is_none() { return pr_details(cwd, number); }
    let target = associated_target(number, url)?;
    let out = run(&outside_checkouts(), &["pr", "view", &target, "--json", FIELDS])?;
    Ok(parse_pr(&serde_json::from_str(&out)?))
}

pub fn merge_associated_pr(cwd: &Path, number: u64, method: &str, url: Option<&str>) -> Result<()> {
    if url.is_none() { return merge_pr(cwd, number, method); }
    let target = associated_target(number, url)?;
    merge_pr_target(&outside_checkouts(), &target, method)
}

pub fn ready_associated_pr(cwd: &Path, number: u64, url: Option<&str>) -> Result<()> {
    if url.is_none() { return mark_ready(cwd, number); }
    let target = associated_target(number, url)?;
    run(&outside_checkouts(), &["pr", "ready", &target]).map(|_| ())
}

pub fn create_pr(cwd: &Path, title: &str, body: &str, base: Option<&str>, draft: bool) -> Result<String> {
    create_pr_with(cwd, title, body, base, draft, run)
}

fn create_pr_with(cwd: &Path, title: &str, body: &str, base: Option<&str>, draft: bool, run: impl FnOnce(&Path, &[&str]) -> Result<String>) -> Result<String> {
    let mut args = vec!["pr", "create", "--title", title, "--body", body];
    if let Some(b) = base {
        args.extend(["--base", b]);
    }
    if draft {
        args.push("--draft");
    }
    let out = run(cwd, &args)?;
    let url = out.trim().lines().last().unwrap_or("").to_string();
    if let Err(error) = crate::stats::record_pr(&url) {
        log::warn!("record created PR: {error:#}");
        crate::store::activity::report_error(format!("The PR was created, but saving its activity failed: {error:#}"));
    }
    Ok(url)
}

/// The pull request as the issue pipeline's merge gate reads it. Validation
/// requests name `head_sha`, and a final head read invalidates that evidence
/// if the branch moved while it was collected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSnapshot {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub body: String,
    /// OPEN | MERGED | CLOSED
    pub state: String,
    pub is_draft: bool,
    pub base: String,
    pub head: String,
    pub head_sha: String,
    /// MERGEABLE | CONFLICTING | UNKNOWN
    pub mergeable: String,
    /// CLEAN | UNSTABLE | BLOCKED | BEHIND | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN
    pub merge_state: String,
    #[serde(default)]
    pub review_decision: Option<String>,
    pub checks: Vec<PrCheck>,
    /// Required checks reported by GitHub, by name. With none reported,
    /// every check counts. GitHub's merge state also gates unpublished
    /// requirements, which `gh pr checks --required` does not list.
    #[serde(default)]
    pub required_checks: Option<Vec<String>>,
    /// GitHub would not let this token read the commit's checks: a cloud
    /// workspace's token may lack the permission. `checks` is then empty and
    /// says nothing; no merge is concluded from it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub checks_unread: bool,
    /// None means workflow/suite evidence has not been read. An empty list is
    /// a successful read with no producers, not permission to assume no CI.
    #[serde(default)]
    pub validation: Option<Vec<PrCheck>>,
}

const SNAPSHOT_FIELDS: &str = "number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body,author";

pub(crate) fn parse_snapshot(v: &Value) -> PrSnapshot {
    let pr = parse_pr(v);
    PrSnapshot {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        is_draft: pr.is_draft,
        base: pr.base,
        head: pr.head,
        head_sha: v["headRefOid"].as_str().unwrap_or("").into(),
        mergeable: pr.mergeable,
        merge_state: v["mergeStateStatus"].as_str().unwrap_or("UNKNOWN").into(),
        review_decision: pr.review_decision,
        checks: pr.checks,
        required_checks: None,
        checks_unread: false,
        validation: None,
    }
}

/// What a `gh` call printed and how it ended, for the calls whose exit code
/// is part of the answer.
pub(crate) struct GhOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

fn run_output(cwd: &Path, args: &[&str]) -> Result<GhOutput> {
    let mut command = gh()?;
    command.current_dir(cwd).args(args);
    let out = output_within(command, GH_TIMEOUT).with_context(|| format!("gh {}", args.join(" ")))?;
    Ok(GhOutput {
        success: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

/// The names of the checks branch protection requires on this pull request.
/// `gh pr checks --required` exits non-zero while one is pending or failing
/// and still prints the list. With none required it says so in words, and in
/// different words when the commit has no checks of any kind.
pub(crate) fn parse_required_checks(output: &GhOutput) -> Result<Option<Vec<String>>> {
    if let Ok(Value::Array(checks)) = serde_json::from_str::<Value>(output.stdout.trim()) {
        let names: BTreeSet<String> = checks.iter().map(|check| check["name"].as_str().filter(|name| !name.is_empty()).map(String::from).context("GitHub omitted a required check name")).collect::<Result<_>>()?;
        return Ok((!names.is_empty()).then(|| names.into_iter().collect()));
    }
    let said = |words: &str| output.stderr.contains(words) || output.stdout.contains(words);
    if said("no required checks reported") || said("no checks reported") {
        return Ok(None);
    }
    bail!("{}", if output.stderr.is_empty() { "gh pr checks --required failed".to_string() } else { output.stderr.clone() })
}

/// One pull request with its head commit, the checks on that commit, and
/// which of them are required.
pub fn pr_snapshot(cwd: &Path, number: u64) -> Result<PrSnapshot> {
    pr_snapshot_with(cwd, number, run, run_output)
}

/// The fields of a snapshot without the checks: what a token that may not
/// read them can still be told.
fn without_checks(fields: &str) -> String {
    fields.split(',').filter(|field| *field != "statusCheckRollup").collect::<Vec<_>>().join(",")
}

/// GitHub's refusal of something this token's permissions do not cover. An
/// installation token (a cloud workspace's) is refused a commit's checks
/// unless its App was granted them.
pub(crate) fn not_permitted(message: &str) -> bool {
    message.contains("Resource not accessible by integration")
}

fn pr_snapshot_with(
    cwd: &Path,
    number: u64,
    mut run: impl FnMut(&Path, &[&str]) -> Result<String>,
    run_output: impl FnOnce(&Path, &[&str]) -> Result<GhOutput>,
) -> Result<PrSnapshot> {
    let n = number.to_string();
    let (out, checks_unread) = match run(cwd, &["pr", "view", &n, "--json", SNAPSHOT_FIELDS]) {
        Ok(out) => (out, false),
        // Everything but the checks, which are then said to be unread.
        Err(error) if not_permitted(&format!("{error:#}")) => (run(cwd, &["pr", "view", &n, "--json", &without_checks(SNAPSHOT_FIELDS)]).map_err(|_| error)?, true),
        Err(error) => return Err(error),
    };
    let mut snapshot = parse_snapshot(&serde_json::from_str(&out)?);
    snapshot.checks_unread = checks_unread;
    if snapshot.head_sha.is_empty() {
        bail!("GitHub did not say which commit pull request #{number} is at.");
    }
    // Only an open pull request has checks left to wait for.
    if snapshot.state == "OPEN" && !snapshot.checks_unread {
        let required = run_output(cwd, &["pr", "checks", &n, "--required", "--json", "name"])?;
        if not_permitted(&required.stderr) {
            snapshot.checks_unread = true;
            snapshot.checks.clear();
        } else {
            snapshot.required_checks = parse_required_checks(&required)?;
        }
    }
    if snapshot.state == "OPEN" && !snapshot.checks_unread {
        let evidence = validation_with(cwd, &snapshot, &mut run);
        match evidence {
            Ok((validation, checks)) => {
                snapshot.validation = Some(validation);
                snapshot.checks = checks;
            }
            Err(error) if not_permitted(&format!("{error:#}")) => snapshot.checks_unread = true,
            Err(error) => return Err(error),
        }
        // Every request above names the original SHA. Re-read the PR after
        // collecting evidence so a changed head cannot inherit that evidence.
        let current: Value = serde_json::from_str(&run(cwd, &["pr", "view", &n, "--json", "headRefOid"])?)?;
        let head = current["headRefOid"].as_str().context("GitHub omitted the current head")?;
        if head != snapshot.head_sha {
            snapshot.head_sha = head.into();
            snapshot.validation = None;
        }
    }
    Ok(snapshot)
}

/// Read all workflow runs and suites for this exact commit, including queued
/// runs whose jobs have not appeared and suites from non-Actions providers.
/// Pagination and total counts are checked: truncated evidence cannot pass.
fn validation_with(cwd: &Path, pr: &PrSnapshot, run: &mut impl FnMut(&Path, &[&str]) -> Result<String>) -> Result<(Vec<PrCheck>, Vec<PrCheck>)> {
    let (repo, _) = pr_url_parts(&pr.url).context("GitHub omitted the pull request repository")?;
    let mut read = |path: &str, key: &str| -> Result<Vec<Value>> {
        let pages: Vec<Value> = serde_json::from_str(&run(cwd, &["api", path, "--paginate", "--slurp"])?)?;
        let total = pages.first().and_then(|page| page["total_count"].as_u64()).context("GitHub omitted validation count")?;
        let mut records = Vec::new();
        let mut ids = BTreeSet::new();
        for page in &pages {
            if page["total_count"].as_u64() != Some(total) {
                bail!("GitHub validation changed during pagination; retry the snapshot");
            }
            for record in page[key].as_array().context("GitHub omitted validation records")? {
                let id = record["id"].as_u64().context("GitHub omitted validation identity")?;
                if !ids.insert(id) { bail!("GitHub repeated validation records during pagination; retry the snapshot"); }
                records.push(record.clone());
            }
        }
        if records.len() as u64 != total {
            bail!("GitHub returned incomplete validation evidence ({}/{total})", records.len());
        }
        records.sort_by_key(|record| record["id"].as_u64());
        Ok(records)
    };
    let workflow_path = format!("repos/{repo}/actions/runs?head_sha={}&per_page=100", pr.head_sha);
    let suite_path = format!("repos/{repo}/commits/{}/check-suites?per_page=100", pr.head_sha);
    let child_path = format!("repos/{repo}/commits/{}/check-runs?filter=latest&per_page=100", pr.head_sha);
    let status_path = format!("repos/{repo}/commits/{}/status?per_page=100", pr.head_sha);
    // Bracket the child reads with producer reads. A rerun can finish between
    // requests with the same SHA, suite ID, count and aggregate conclusion.
    // Actions' attempt identity must therefore be present and unchanged too.
    let workflows = read(&workflow_path, "workflow_runs")?;
    for workflow in &workflows {
        workflow["run_attempt"].as_u64().filter(|attempt| *attempt > 0).context("GitHub omitted the workflow attempt")?;
    }
    let suite_records = read(&suite_path, "check_suites")?;
    let children = read(&child_path, "check_runs")?;
    let statuses = read(&status_path, "statuses")?;
    let mut attempt_consistent = true;
    let mut unexplained_workflows = BTreeSet::new();
    let mut explained_suites = BTreeSet::new();
    // Repeated latest-check reads can consistently lag behind a finished
    // rerun. Only jobs from the explicit Actions attempt may explain its
    // failed aggregate, and every such job must agree with its check run.
    for workflow in &workflows {
        if workflow["status"].as_str() != Some("completed") || !failed_validation(validation_state(workflow)?) { continue; }
        let id = workflow["id"].as_u64().context("GitHub omitted workflow identity")?;
        let attempt = workflow["run_attempt"].as_u64().context("GitHub omitted the workflow attempt")?;
        let jobs = read(&format!("repos/{repo}/actions/runs/{id}/attempts/{attempt}/jobs?per_page=100"), "jobs")?;
        if !jobs.iter().any(|job| validation_state(job).is_ok_and(failed_validation)) {
            unexplained_workflows.insert(id);
        } else if let Some(suite) = workflow["check_suite_id"].as_u64() {
            explained_suites.insert(suite);
        }
        for job in jobs {
            let check_id = job["check_run_url"].as_str().and_then(|url| url.rsplit('/').next()).and_then(|id| id.parse::<u64>().ok());
            let matching_child = children.iter().find(|child| check_id.is_some() && child["id"].as_u64() == check_id);
            if job["run_id"].as_u64() != Some(id) || job["head_sha"].as_str() != Some(&pr.head_sha)
                || job.get("run_attempt").is_some_and(|value| value.as_u64() != Some(attempt))
                || !matching_child.is_some_and(|child| child["check_suite"]["id"] == workflow["check_suite_id"]
                    && child["name"] == job["name"] && child["status"] == job["status"] && child["conclusion"] == job["conclusion"]) {
                attempt_consistent = false;
            }
        }
    }
    let workflows_after = read(&workflow_path, "workflow_runs")?;
    let suites_after = read(&suite_path, "check_suites")?;
    // Suites from other providers have no attempt number. Re-read the child
    // identities and results as well, so in-place changes cannot be used to
    // explain away a producer failure with an older optional job failure.
    let children_after = read(&child_path, "check_runs")?;
    let statuses_after = read(&status_path, "statuses")?;
    if !attempt_consistent || workflows != workflows_after || suite_records != suites_after || children != children_after || statuses != statuses_after {
        // A normal race is pending, not a successful validation or a terminal
        // error. The pipeline's next poll collects a fresh complete snapshot.
        return Ok((vec![PrCheck { name: "validation changed during collection; waiting for a consistent attempt".into(), state: "pending".into(), url: None }], Vec::new()));
    }
    let mut checks = Vec::new();
    for child in &children {
        if child["head_sha"].as_str() != Some(&pr.head_sha) { bail!("GitHub returned a check for a different commit"); }
        checks.push(PrCheck {
            name: child["name"].as_str().context("GitHub omitted a check name")?.into(),
            state: validation_state(child)?.into(), url: None,
        });
    }
    for status in statuses {
        checks.push(PrCheck {
            name: status["context"].as_str().context("GitHub omitted a status context")?.into(),
            state: status["state"].as_str().context("GitHub omitted a status state")?.into(), url: None,
        });
    }
    let mut validation = Vec::new();
    let mut suites = BTreeSet::new();
    let mut workflow_suites = Vec::new();
    for (records, key) in [(workflows, "workflow_runs"), (suite_records, "check_suites")] {
        for item in records {
            if item["head_sha"].as_str() != Some(&pr.head_sha) { bail!("GitHub returned validation for a different commit"); }
            let id = item["id"].as_u64().context("GitHub omitted validation identity")?;
            let mut state = validation_state(&item)?;
            let suite = if key == "check_suites" { Some(id) } else { item["check_suite_id"].as_u64() };
            if key == "check_suites" {
                suites.insert(id);
                let expected = item["latest_check_runs_count"].as_u64().context("GitHub omitted the suite's check count")?;
                let observed = children.iter().filter(|child| child["check_suite"]["id"].as_u64() == Some(id)).count() as u64;
                if observed != expected { state = "pending"; }
            } else {
                workflow_suites.push(suite.context("GitHub omitted the workflow's check suite")?);
            }
            // Only verified jobs from the consistent Actions attempt may
            // explain an aggregate failure as an optional child failure.
            // Other providers have no verifiable attempt membership here;
            // their failed aggregates remain blocking, even if a child is ignored.
            let explained = if key == "workflow_runs" { !unexplained_workflows.contains(&id) } else { explained_suites.contains(&id) };
            if failed_validation(state) && explained && suite.is_some_and(|suite| children.iter().any(|child| child["check_suite"]["id"].as_u64() == Some(suite) && validation_state(child).is_ok_and(failed_validation))) {
                state = "success";
            }
            let name = item["name"].as_str().or_else(|| item["app"]["slug"].as_str()).unwrap_or(key);
            validation.push(PrCheck { name: format!("{name} ({key} #{id})"), state: state.into(), url: None });
        }
    }
    // Missing suites are incomplete evidence even when another producer has
    // already published successful checks.
    for suite in workflow_suites.into_iter().chain(children.iter().map(|child| child["check_suite"]["id"].as_u64().unwrap_or(0))) {
        if !suites.contains(&suite) {
            validation.push(PrCheck { name: format!("check suite #{suite}"), state: "pending".into(), url: None });
        }
    }
    Ok((validation, checks))
}

fn validation_state(item: &Value) -> Result<&str> {
    let status = item["status"].as_str().context("GitHub omitted validation status")?;
    // A rerun can retain its previous conclusion while queued.
    Ok(match status {
        "completed" => item["conclusion"].as_str().unwrap_or("pending"),
        "queued" | "in_progress" | "pending" | "requested" | "waiting" => status,
        _ => "pending",
    })
}

fn failed_validation(state: &str) -> bool {
    matches!(state, "failure" | "error" | "cancelled" | "timed_out" | "action_required" | "startup_failure" | "stale")
}

/// The open pull request whose head is `branch` in this repository (not a
/// fork's branch of the same name), by number. Asks for nothing but that, so
/// a token that may not read checks is answered too.
pub fn open_pr_for_branch(cwd: &Path, branch: &str) -> Result<Option<u64>> {
    open_pr_for_branch_with(cwd, branch, run)
}

fn open_pr_for_branch_with(cwd: &Path, branch: &str, run: impl FnOnce(&Path, &[&str]) -> Result<String>) -> Result<Option<u64>> {
    let out = run(cwd, &["pr", "list", "--head", branch, "--state", "open", "--json", "number,isCrossRepository", "--limit", "100"])?;
    let listed: Value = serde_json::from_str(&out)?;
    Ok(listed.as_array().into_iter().flatten().filter(|pr| pr["isCrossRepository"] != Value::Bool(true)).filter_map(|pr| pr["number"].as_u64()).max())
}

/// Leave a comment on a pull request; the comment's URL.
pub fn comment_pr(cwd: &Path, number: u64, body: &str) -> Result<String> {
    let out = run(cwd, &["pr", "comment", &number.to_string(), "--body", body])?;
    Ok(out.trim().lines().last().unwrap_or("").to_string())
}

pub fn edit_pr_body(cwd: &Path, number: u64, body: &str) -> Result<()> {
    run(cwd, &["pr", "edit", &number.to_string(), "--body", body]).map(|_| ())
}

fn merge_flag(method: &str) -> &'static str {
    match method {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    }
}

/// How a merge pinned to one commit ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinnedMerge {
    Merged,
    /// GitHub took the request and has not merged yet: a merge queue.
    Accepted,
    /// The pull request's head is not the commit that was asked for.
    HeadMoved { head: String },
    /// GitHub's own words.
    Refused(String),
}

/// Merge a pull request only if its head is still `commit`. Never `--admin`
/// and never `--auto`: branch protection decides, and a merge GitHub would
/// make later is one made of a head nobody pinned.
pub fn merge_pr_at(cwd: &Path, number: u64, method: &str, commit: &str) -> Result<PinnedMerge> {
    merge_pr_at_with(cwd, number, method, commit, run_output, pr_snapshot)
}

fn merge_pr_at_with(
    cwd: &Path,
    number: u64,
    method: &str,
    commit: &str,
    run_output: impl FnOnce(&Path, &[&str]) -> Result<GhOutput>,
    snapshot: impl FnOnce(&Path, u64) -> Result<PrSnapshot>,
) -> Result<PinnedMerge> {
    let n = number.to_string();
    let merged = run_output(cwd, &["pr", "merge", &n, merge_flag(method), "--match-head-commit", commit])?;
    // `gh pr merge` can fail with the merge already through, and can succeed
    // with the pull request only queued: the pull request itself is asked.
    let now = snapshot(cwd, number);
    match (merged.success, now) {
        (_, Ok(pr)) if pr.state == "MERGED" => Ok(PinnedMerge::Merged),
        // GitHub took it; whether it is merged yet is read on the next look.
        (true, _) => Ok(PinnedMerge::Accepted),
        (false, Ok(pr)) if !pr.head_sha.eq_ignore_ascii_case(commit) => Ok(PinnedMerge::HeadMoved { head: pr.head_sha }),
        (false, _) => Ok(PinnedMerge::Refused(if merged.stderr.is_empty() { "GitHub refused the merge.".into() } else { merged.stderr })),
    }
}

// ---- a pull request named by its repository, with no checkout ---------------
//
// A cloud workspace's pull request is merged from the desktop, with the
// reader's own `gh` (#433). The desktop need not have a checkout of it, so
// these name the repository instead of running in one.

/// The repository (`owner/name`) and number of a pull request on github.com.
pub fn pr_url_parts(url: &str) -> Option<(String, u64)> {
    let rest = url.trim().strip_prefix("https://github.com/")?;
    let mut parts = rest.trim_end_matches('/').split('/');
    let (owner, name, pull, number) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    let valid = |part: &str| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
    if pull != "pull" || parts.next().is_some() || !valid(owner) || !valid(name) {
        return None;
    }
    Some((format!("{owner}/{name}"), number.parse().ok()?))
}

/// `args` with `--repo <repo>` after them.
fn in_repo<'a>(args: &[&'a str], repo: &'a str) -> Vec<&'a str> {
    let mut named = args.to_vec();
    named.extend(["--repo", repo]);
    named
}

/// Where a `gh` call that names its repository runs: anywhere but a checkout
/// of some other repository, whose `origin` it might otherwise read.
fn outside_checkouts() -> PathBuf {
    std::env::temp_dir()
}

/// [`pr_snapshot`] of a pull request in `repo` (`owner/name`).
pub fn pr_snapshot_in(repo: &str, number: u64) -> Result<PrSnapshot> {
    let cwd = outside_checkouts();
    pr_snapshot_with(&cwd, number, |cwd, args| if args.first() == Some(&"api") { run(cwd, args) } else { run(cwd, &in_repo(args, repo)) }, |cwd, args| run_output(cwd, &in_repo(args, repo)))
}

/// [`merge_pr_at`] of a pull request in `repo` (`owner/name`).
pub fn merge_pr_at_in(repo: &str, number: u64, method: &str, commit: &str) -> Result<PinnedMerge> {
    let cwd = outside_checkouts();
    merge_pr_at_with(&cwd, number, method, commit, |cwd, args| run_output(cwd, &in_repo(args, repo)), |_, number| pr_snapshot_in(repo, number))
}

pub fn merge_pr(cwd: &Path, number: u64, method: &str) -> Result<()> {
    merge_pr_target(cwd, &number.to_string(), method)
}

fn merge_pr_target(cwd: &Path, target: &str, method: &str) -> Result<()> {
    let flag = merge_flag(method);
    let result = run(cwd, &["pr", "merge", target, flag]);
    if result.is_err() {
        // `gh pr merge` can fail with the merge already through; ask again.
        let out = run(cwd, &["pr", "view", target, "--json", "state"])?;
        let v: Value = serde_json::from_str(&out)?;
        if v["state"].as_str() == Some("MERGED") {
            return Ok(());
        }
    }
    result.map(|_| ())
}

pub fn mark_ready(cwd: &Path, number: u64) -> Result<()> {
    run(cwd, &["pr", "ready", &number.to_string()]).map(|_| ())
}

pub fn available() -> bool {
    crate::binpath::resolve("gh").is_some()
}

// ---- for the removal of a workspace once its pull request has merged --------
//
// These run unattended and on a timer (`merged_cleanup.rs`), so each has a
// deadline, and the pull requests of every branch of a project are read in
// one request rather than one `gh pr list` per worktree.

/// How long one of these calls may take.
const BOUNDED: std::time::Duration = std::time::Duration::from_secs(30);

fn run_bounded(cwd: &Path, args: &[&str]) -> Result<String> {
    let mut command = gh()?;
    command.current_dir(cwd).args(args).env("GH_NO_UPDATE_NOTIFIER", "1");
    crate::git::output_within(command, BOUNDED).map_err(|error| anyhow!("gh {}: {error}", args.first().copied().unwrap_or_default()))
}

/// The GitHub repository a checkout's pull requests are in, as `gh` resolves it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RepoRef {
    host: String,
    owner: String,
    name: String,
}

fn parse_repo_ref(out: &str) -> Result<RepoRef> {
    let value: Value = serde_json::from_str(out)?;
    let field = |value: &Value| value.as_str().filter(|text| !text.is_empty()).map(String::from);
    let host = value["url"].as_str().and_then(|url| url.split_once("://")).and_then(|(_, rest)| rest.split('/').next()).filter(|host| !host.is_empty());
    match (host, field(&value["owner"]["login"]), field(&value["name"])) {
        (Some(host), Some(owner), Some(name)) => Ok(RepoRef { host: host.to_string(), owner, name }),
        _ => bail!("gh did not say which repository this is"),
    }
}

/// Asked once per checkout and remote: which repository a directory belongs
/// to does not change while its `origin` does not.
fn repo_ref(cwd: &Path) -> Result<RepoRef> {
    type Known = std::sync::Mutex<std::collections::HashMap<(PathBuf, String), RepoRef>>;
    static KNOWN: std::sync::OnceLock<Known> = std::sync::OnceLock::new();
    let key = (canonical_path(cwd), crate::git::remote_url(cwd).unwrap_or_default());
    let known = KNOWN.get_or_init(Default::default);
    if let Some(found) = known.lock().unwrap().get(&key) {
        return Ok(found.clone());
    }
    let found = parse_repo_ref(&run_bounded(cwd, &["repo", "view", "--json", "owner,name,url"])?)?;
    known.lock().unwrap().insert(key, found.clone());
    Ok(found)
}

/// The pull request a branch is on, with the commit its head was at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchPr {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// OPEN | MERGED | CLOSED
    pub state: String,
    /// The commit its head is at; for a merged one, the commit that was merged.
    pub head: String,
    pub base: String,
}

/// How many branches one request asks about.
const BRANCHES_PER_REQUEST: usize = 40;

/// One aliased `pullRequests` connection per branch. The names travel as
/// variables, never inside the query text.
fn branch_prs_query(count: usize) -> String {
    let variables: String = (0..count).map(|i| format!(",$b{i}:String!")).collect();
    let fields: String = (0..count)
        .map(|i| format!("b{i}:pullRequests(headRefName:$b{i},first:20,orderBy:{{field:CREATED_AT,direction:DESC}}){{nodes{{number title url state isCrossRepository headRefOid baseRefName}}}}"))
        .collect();
    format!("query($owner:String!,$name:String!{variables}){{repository(owner:$owner,name:$name){{{fields}}}}}")
}

/// The pull request that speaks for a branch: the open one if there is one,
/// else the newest, as [`prs_for_branch`] orders them. One from a fork is
/// another repository's branch of the same name, and is not this branch's.
fn pick_pr(nodes: &[Value]) -> Option<BranchPr> {
    let own = nodes.iter().filter(|pr| pr["isCrossRepository"].as_bool() != Some(true));
    let pr = own.max_by_key(|pr| (pr["state"].as_str() == Some("OPEN"), pr["number"].as_u64().unwrap_or(0)))?;
    Some(BranchPr {
        number: pr["number"].as_u64().filter(|number| *number > 0)?,
        title: pr["title"].as_str().unwrap_or("").into(),
        url: pr["url"].as_str().unwrap_or("").into(),
        state: pr["state"].as_str()?.into(),
        head: pr["headRefOid"].as_str().filter(|head| !head.is_empty())?.into(),
        base: pr["baseRefName"].as_str().unwrap_or("").into(),
    })
}

fn parse_branch_prs(out: &str, branches: &[String]) -> Result<std::collections::HashMap<String, BranchPr>> {
    let value: Value = serde_json::from_str(out)?;
    let repository = &value["data"]["repository"];
    if !repository.is_object() {
        bail!("GitHub did not return the repository (no access, or it was renamed)");
    }
    let mut found = std::collections::HashMap::new();
    for (i, branch) in branches.iter().enumerate() {
        let nodes = repository[format!("b{i}")]["nodes"].as_array().with_context(|| format!("GitHub did not answer for the branch {branch}"))?;
        if let Some(pr) = pick_pr(nodes) {
            found.insert(branch.clone(), pr);
        }
    }
    Ok(found)
}

/// The pull request of each of `branches` in the repository `cwd` belongs to.
/// A branch with none is left out. An error means nothing is known, which is
/// never the same as "no pull request".
pub fn branch_prs(cwd: &Path, branches: &[String]) -> Result<std::collections::HashMap<String, BranchPr>> {
    let mut found = std::collections::HashMap::new();
    if branches.is_empty() {
        return Ok(found);
    }
    #[cfg(test)]
    if let Some(stood_in) = stand_in::answer(cwd, branches) {
        return stood_in;
    }
    let repo = repo_ref(cwd)?;
    for chunk in branches.chunks(BRANCHES_PER_REQUEST) {
        let fields: Vec<String> = [format!("query={}", branch_prs_query(chunk.len())), format!("owner={}", repo.owner), format!("name={}", repo.name)]
            .into_iter()
            .chain(chunk.iter().enumerate().map(|(i, branch)| format!("b{i}={branch}")))
            .collect();
        // `-f` sends each value as a string: a branch named `true` or `7`
        // stays a name.
        let mut args = vec!["api", "graphql", "--hostname", repo.host.as_str()];
        args.extend(fields.iter().flat_map(|field| ["-f", field.as_str()]));
        found.extend(parse_branch_prs(&run_bounded(cwd, &args)?, chunk)?);
    }
    Ok(found)
}

/// What a branch's pull request says about the issues it works on (#441):
/// its state, and the issues it closes as GitHub links them, with its title
/// and body for the trackers GitHub does not link (a Linear `ENG-42`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchPrIssues {
    /// OPEN | MERGED | CLOSED
    pub state: String,
    pub title: String,
    pub body: String,
    /// `(owner/name, number)` of each issue it closes.
    pub closes: Vec<(String, u64)>,
}

fn branch_pr_issues_query(count: usize) -> String {
    let variables: String = (0..count).map(|i| format!(",$b{i}:String!")).collect();
    let fields: String = (0..count)
        .map(|i| format!("b{i}:pullRequests(headRefName:$b{i},first:5,orderBy:{{field:CREATED_AT,direction:DESC}}){{nodes{{number state isCrossRepository title body closingIssuesReferences(first:10){{nodes{{number repository{{nameWithOwner}}}}}}}}}}"))
        .collect();
    format!("query($owner:String!,$name:String!{variables}){{repository(owner:$owner,name:$name){{{fields}}}}}")
}

fn parse_branch_pr_issues(out: &str, branches: &[String]) -> Result<std::collections::HashMap<String, BranchPrIssues>> {
    let value: Value = serde_json::from_str(out)?;
    let repository = &value["data"]["repository"];
    if !repository.is_object() {
        bail!("GitHub did not return the repository (no access, or it was renamed)");
    }
    let mut found = std::collections::HashMap::new();
    for (i, branch) in branches.iter().enumerate() {
        let nodes = repository[format!("b{i}")]["nodes"].as_array().with_context(|| format!("GitHub did not answer for the branch {branch}"))?;
        // As `pick_pr`: the open one, else the newest; never a fork's.
        let own = nodes.iter().filter(|pr| pr["isCrossRepository"].as_bool() != Some(true));
        let Some(pr) = own.max_by_key(|pr| (pr["state"].as_str() == Some("OPEN"), pr["number"].as_u64().unwrap_or(0))) else { continue };
        let Some(state) = pr["state"].as_str() else { continue };
        let closes = pr["closingIssuesReferences"]["nodes"]
            .as_array()
            .map(|nodes| nodes.iter().filter_map(|issue| Some((issue["repository"]["nameWithOwner"].as_str()?.to_string(), issue["number"].as_u64()?))).collect())
            .unwrap_or_default();
        found.insert(branch.clone(), BranchPrIssues { state: state.into(), title: pr["title"].as_str().unwrap_or("").into(), body: pr["body"].as_str().unwrap_or("").into(), closes });
    }
    Ok(found)
}

/// [`branch_prs`], with the issues each pull request closes (#441).
pub fn branch_pr_issues(cwd: &Path, branches: &[String]) -> Result<std::collections::HashMap<String, BranchPrIssues>> {
    let mut found = std::collections::HashMap::new();
    if branches.is_empty() {
        return Ok(found);
    }
    let repo = repo_ref(cwd)?;
    for chunk in branches.chunks(BRANCHES_PER_REQUEST) {
        let fields: Vec<String> = [format!("query={}", branch_pr_issues_query(chunk.len())), format!("owner={}", repo.owner), format!("name={}", repo.name)]
            .into_iter()
            .chain(chunk.iter().enumerate().map(|(i, branch)| format!("b{i}={branch}")))
            .collect();
        let mut args = vec!["api", "graphql", "--hostname", repo.host.as_str()];
        args.extend(fields.iter().flat_map(|field| ["-f", field.as_str()]));
        found.extend(parse_branch_pr_issues(&run_bounded(cwd, &args)?, chunk)?);
    }
    Ok(found)
}

/// Lets a test answer for GitHub about the repository at one path, which a
/// repository made in a temporary directory has no GitHub to ask about.
#[cfg(test)]
pub(crate) mod stand_in {
    use super::*;
    use std::collections::HashMap;

    type Answers = std::sync::Mutex<HashMap<PathBuf, std::result::Result<HashMap<String, BranchPr>, String>>>;

    fn answers() -> &'static Answers {
        static ANSWERS: std::sync::OnceLock<Answers> = std::sync::OnceLock::new();
        ANSWERS.get_or_init(Default::default)
    }

    /// From now on `branch_prs` for the repository at `cwd` answers this.
    pub(crate) fn set(cwd: &Path, prs: std::result::Result<HashMap<String, BranchPr>, String>) {
        answers().lock().unwrap().insert(canonical_path(cwd), prs);
    }

    pub(super) fn answer(cwd: &Path, branches: &[String]) -> Option<Result<HashMap<String, BranchPr>>> {
        let known = answers().lock().unwrap().get(&canonical_path(cwd)).cloned()?;
        Some(known.map(|prs| prs.into_iter().filter(|(branch, _)| branches.contains(branch)).collect()).map_err(|error| anyhow!(error)))
    }
}

/// GitHub's own "Automatically delete head branches" for a repository.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeadBranchSetting {
    /// `owner/name`.
    pub repository: String,
    /// Whether GitHub deletes a pull request's branch itself once it merges.
    /// `None` when GitHub does not tell this reader.
    pub enabled: Option<bool>,
    /// The reader may change it.
    pub admin: bool,
}

fn parse_head_branch_setting(out: &str) -> Result<HeadBranchSetting> {
    let value: Value = serde_json::from_str(out)?;
    Ok(HeadBranchSetting {
        repository: value["full_name"].as_str().context("GitHub did not name the repository")?.to_string(),
        enabled: value["delete_branch_on_merge"].as_bool(),
        admin: value["permissions"]["admin"].as_bool().unwrap_or(false),
    })
}

pub fn head_branch_setting(cwd: &Path) -> Result<HeadBranchSetting> {
    let repo = repo_ref(cwd)?;
    parse_head_branch_setting(&run_bounded(cwd, &["api", "--hostname", &repo.host, &format!("repos/{}/{}", repo.owner, repo.name)])?)
}

/// Turn "Automatically delete head branches" on. GitHub refuses unless the
/// reader administers the repository.
pub fn enable_head_branch_deletion(cwd: &Path) -> Result<HeadBranchSetting> {
    let repo = repo_ref(cwd)?;
    let path = format!("repos/{}/{}", repo.owner, repo.name);
    parse_head_branch_setting(&run_bounded(cwd, &["api", "--hostname", &repo.host, "--method", "PATCH", &path, "-F", "delete_branch_on_merge=true"])?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_discovery_keeps_same_branch_followups_but_not_an_unrelated_fork() {
        let _home = crate::store::temp_home();
        let cwd = crate::store::root().unwrap();
        crate::git::run(&cwd, &["init", "-q"]).unwrap();
        crate::git::run(&cwd, &["remote", "add", "origin", "https://github.com/acme/widgets.git"]).unwrap();
        let prs = prs_for_branch_with(&cwd, "feature", |_, args| {
            assert!(args.windows(2).any(|pair| pair == ["--head", "feature"]));
            assert!(args.windows(2).any(|pair| pair == ["--state", "all"]));
            Ok(serde_json::json!([
                {"number":1,"url":"https://github.com/acme/widgets/pull/1","headRefName":"feature","state":"MERGED","isCrossRepository":false},
                {"number":2,"url":"https://github.com/acme/widgets/pull/2","headRefName":"feature","state":"OPEN","isCrossRepository":false},
                {"number":3,"url":"https://github.com/acme/widgets/pull/3","headRefName":"feature","state":"OPEN","isCrossRepository":true,"headRepositoryOwner":{"login":"unrelated"},"headRepository":{"name":"widgets"}}
            ]).to_string())
        }).unwrap();
        assert_eq!(prs.iter().map(|pr| pr.number).collect::<Vec<_>>(), [2, 1]);
    }

    #[test]
    fn associated_targets_keep_repository_identity_and_reject_mismatched_numbers() {
        assert_eq!(associated_target(7, Some("https://github.com/Acme/one/pull/7/")).unwrap(), "https://github.com/acme/one/pull/7");
        assert_eq!(associated_target(7, Some("https://github.com/Acme/two/pull/7")).unwrap(), "https://github.com/acme/two/pull/7");
        assert!(associated_target(8, Some("https://github.com/acme/one/pull/7")).is_err());
        assert!(associated_target(7, Some("--repo=unrelated")).is_err());
    }

    #[test]
    fn branch_discovery_counts_cli_pr_once_and_retains_merge_close_history() {
        let _home = crate::store::temp_home();
        let cwd = crate::store::root().unwrap();
        let session = serde_json::from_value(serde_json::json!({
            "id":"s", "projectPath":cwd, "cwd":cwd, "branch":"feature", "title":"Work",
            "created":"2026-09-01T00:00:00Z", "modified":"2026-09-01T00:00:00Z"
        })).unwrap();
        crate::store::index::save(&[session]).unwrap();
        for state in ["OPEN", "OPEN", "MERGED", "CLOSED"] {
            let prs = prs_for_branch_with(&cwd, "feature", |_, args| {
                assert!(args.windows(2).any(|pair| pair == ["--state", "all"]));
                Ok(serde_json::json!([{"number":111,"url":"https://github.com/terminalx-ai/raccoon/pull/111","state":state}]).to_string())
            }).unwrap();
            assert_eq!(prs[0].state, state);
        }
        // App creation followed by discovery uses exactly the same registry.
        create_pr_with(&cwd, "Fix", "Details", None, true, |_, _| {
            Ok("https://GITHUB.COM/TerminalX-AI/Raccoon/pull/111/\n".into())
        }).unwrap();
        assert_eq!(crate::store::activity::summary().unwrap().prs_created, 1);
        prs_for_branch_with(&cwd, "untracked", |_, _| {
            Ok(r#"[{"number":112,"url":"https://github.com/terminalx-ai/raccoon/pull/112"}]"#.into())
        }).unwrap();
        assert_eq!(crate::store::activity::summary().unwrap().prs_created, 1);
        crate::store::index::save(&[]).unwrap();
        assert_eq!(crate::store::activity::summary().unwrap().prs_created, 1);
    }

    #[test]
    fn corrupt_accounting_does_not_hide_a_discovered_pr_or_replace_history() {
        let _home = crate::store::temp_home();
        let cwd = crate::store::root().unwrap();
        let session = serde_json::from_value(serde_json::json!({
            "id":"s", "projectPath":cwd, "cwd":cwd, "branch":"feature", "title":"Work",
            "created":"2026-09-01T00:00:00Z", "modified":"2026-09-01T00:00:00Z"
        })).unwrap();
        crate::store::index::save(&[session]).unwrap();
        std::fs::write(cwd.join("stats-activity.json"), "broken").unwrap();
        let prs = prs_for_branch_with(&cwd, "feature", |_, _| {
            Ok(r#"[{"number":111,"url":"https://github.com/o/r/pull/111"}]"#.into())
        }).unwrap();
        assert_eq!(prs.len(), 1);
        assert!(crate::store::activity::summary().is_err());
        assert_eq!(std::fs::read_to_string(cwd.join("stats-activity.json")).unwrap(), "broken");
    }

    fn output(success: bool, stdout: &str, stderr: &str) -> GhOutput {
        GhOutput { success, stdout: stdout.into(), stderr: stderr.into() }
    }

    const OPEN_PR: &str = r#"{"number":7,"title":"T","url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"raccoon/x","headRefOid":"1111111111111111111111111111111111111111","mergeable":"MERGEABLE","mergeStateStatus":"UNSTABLE","reviewDecision":"","statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"test","status":"IN_PROGRESS","conclusion":""}],"body":"Closes #3","author":{"login":"me"}}"#;

    #[cfg(unix)]
    #[test]
    fn a_call_that_never_answers_is_ended_at_its_deadline() {
        let mut hung = Command::new("/bin/sh");
        hung.args(["-c", "sleep 30"]);
        let started = std::time::Instant::now();
        let error = output_within(hung, std::time::Duration::from_millis(200)).unwrap_err();
        assert!(error.to_string().contains("did not answer"), "{error}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        // One that answers is read whole, both streams, with its exit code.
        let mut answers = Command::new("/bin/sh");
        answers.args(["-c", "printf out; printf err >&2; exit 3"]);
        let out = output_within(answers, std::time::Duration::from_secs(5)).unwrap();
        assert_eq!((out.status.code(), out.stdout.as_slice(), out.stderr.as_slice()), (Some(3), b"out".as_slice(), b"err".as_slice()));
    }

    #[test]
    fn required_checks_are_read_from_every_way_gh_reports_them() {
        // Captured from gh 2.100: nothing required exits 1 with only this line.
        let none = output(false, "", "no required checks reported on the 'raccoon/x' branch");
        assert_eq!(parse_required_checks(&none).unwrap(), None);
        // And this one for a commit with no checks at all: a repository without CI, or one whose CI has not started.
        let no_checks = output(false, "", "no checks reported on the 'feature-demo' branch");
        assert_eq!(parse_required_checks(&no_checks).unwrap(), None);
        // A pending or failing required check exits non-zero and still lists them.
        let pending = output(false, r#"[{"name":"test"},{"name":"build"},{"name":"test"}]"#, "");
        assert_eq!(parse_required_checks(&pending).unwrap(), Some(vec!["build".to_string(), "test".to_string()]));
        assert_eq!(parse_required_checks(&output(true, "[]", "")).unwrap(), None);
        // Anything else is not an answer, and must not read as "nothing is required".
        assert!(parse_required_checks(&output(false, "", "HTTP 502: Bad Gateway")).is_err());
        assert!(parse_required_checks(&output(false, "", "")).is_err());
    }

    fn validation_key(path: &str) -> &str {
        if path.contains("/attempts/") { "jobs" } else if path.contains("actions/runs") { "workflow_runs" } else if path.contains("check-suites") { "check_suites" } else if path.contains("check-runs") { "check_runs" } else { "statuses" }
    }

    fn snapshot_validation(args: &[&str]) -> String {
        let key = validation_key(args[1]);
        if key == "check_runs" {
            return serde_json::json!([{"total_count":2,"check_runs":[
                {"id":1,"name":"build","head_sha":"1111111111111111111111111111111111111111","status":"completed","conclusion":"success"},
                {"id":2,"name":"test","head_sha":"1111111111111111111111111111111111111111","status":"in_progress"}
            ]}]).to_string();
        }
        serde_json::json!([{ "total_count": 0, key: [] }]).to_string()
    }

    #[test]
    fn validation_reads_queued_reruns_all_providers_and_every_page_on_the_exact_head() {
        let pr = parse_snapshot(&serde_json::from_str(OPEN_PR).unwrap());
        let evidence = validation_with(Path::new("/repo"), &pr, &mut |_, args| {
            assert!(args[1].contains(&pr.head_sha));
            assert_eq!(&args[2..], ["--paginate", "--slurp"]);
            let key = validation_key(args[1]);
            if matches!(key, "check_runs" | "statuses") { return Ok(serde_json::json!([{"total_count":0,key:[]}]).to_string()); }
            Ok(serde_json::json!([
                {"total_count":2, key:[{"id":1,"head_sha":pr.head_sha,"status":"completed","conclusion":"success","check_suite_id":1,"run_attempt":1,"latest_check_runs_count":0}]},
                {"total_count":2, key:[{"id":2,"head_sha":pr.head_sha,"status":"queued","conclusion":"success","check_suite_id":2,"run_attempt":1,"latest_check_runs_count":0}]}
            ]).to_string())
        }).unwrap();
        assert_eq!(evidence.0.iter().map(|c| c.state.as_str()).collect::<Vec<_>>(), ["success", "queued", "success", "queued"]);
        for response in [
            "[]", "{}", r#"[{"total_count":1,"check_runs":[]}]"#, r#"[{"total_count":0}]"#,
            r#"[{"total_count":2,"check_runs":[{"id":1},{"id":1}]}]"#,
        ] {
            assert!(validation_with(Path::new("/repo"), &pr, &mut |_, _| Ok(response.into())).is_err());
        }
    }

    #[test]
    fn snapshots_gate_delayed_jobs_reruns_partial_suites_and_optional_failures() {
        use crate::issue_pipeline::gate::{self, tests::merge_verdict, Facts, Gate};
        for (status, conclusion, child_states, expected_count, ignored, passes) in [
            ("queued", "", vec![], 0, false, false),
            ("in_progress", "", vec!["success"], 1, false, false),
            // A pending rerun retains the previous successful jobs/conclusion.
            ("queued", "success", vec!["success", "success"], 2, false, false),
            ("completed", "success", vec!["success"], 2, false, false),
            ("completed", "success", vec!["success", "success"], 2, false, true),
            ("completed", "failure", vec!["success", "failure"], 2, false, false),
            ("completed", "failure", vec!["success", "failure"], 2, true, true),
            // A failing producer without a failing child is not explained away.
            ("completed", "failure", vec!["success"], 1, true, false),
            ("something_new", "success", vec!["success"], 1, false, false),
        ] {
            let pr = pr_snapshot_with(Path::new("/repo"), 7, |_, args| {
                if args[0] != "api" { return Ok(OPEN_PR.into()); }
                let key = validation_key(args[1]);
                let records = match key {
                    "check_runs" => child_states.iter().enumerate().map(|(i, state)| serde_json::json!({
                        "id": i + 1, "name":if i == 0 { "build" } else { "optional" }, "head_sha":"1111111111111111111111111111111111111111",
                        "status":"completed", "conclusion":state, "check_suite":{"id":10}
                    })).collect::<Vec<_>>(),
                    "jobs" => child_states.iter().enumerate().map(|(i, state)| serde_json::json!({
                        "id":i+1,"run_id":10,"name":if i == 0 { "build" } else { "optional" },
                        "head_sha":"1111111111111111111111111111111111111111","status":"completed","conclusion":state,
                        "check_run_url":format!("https://api.github.com/repos/acme/widgets/check-runs/{}", i+1)
                    })).collect(),
                    "statuses" => vec![],
                    _ => vec![serde_json::json!({"id":10,"check_suite_id":10,"run_attempt":1,"name":"CI","head_sha":"1111111111111111111111111111111111111111",
                        "status":status,"conclusion":conclusion,"latest_check_runs_count":expected_count})],
                };
                Ok(serde_json::json!([{"total_count":records.len(),key:records}]).to_string())
            }, |_, _| Ok(output(true, "[]", ""))).unwrap();
            let verdict = merge_verdict(&pr.head_sha);
            let patterns = if ignored { vec!["optional".into()] } else { Vec::new() };
            let result = gate::decide(&Facts { auto_merge:true, require_person:false, cloud:false, verdict:Some(&verdict), pr:&pr,
                security_areas:&[], protected:&[], ignored_checks:&patterns, allow_no_ci:false, checks_vouched:false });
            assert_eq!(matches!(result, Gate::Merge { .. }), passes, "{status} {conclusion} {child_states:?}: {result:?}");
        }
    }

    #[test]
    fn a_completed_rerun_cannot_use_an_old_optional_failure_to_mask_a_new_build_failure() {
        use crate::issue_pipeline::gate::{self, tests::merge_verdict, Facts, Gate, StopReason, Wait};
        // Both attempts have the same head, suite, child count and failed
        // aggregate. Only the attempt identity and/or child results change.
        for change in ["attempt", "children", "both", "lag_ids", "lag_results", "unverifiable_provider"] {
            for retry in [false, true] {
                let mut workflow_reads = 0;
                let mut child_reads = 0;
                let pr = pr_snapshot_with(Path::new("/repo"), 7, |_, args| {
                    if args[0] != "api" { return Ok(OPEN_PR.into()); }
                    let key = validation_key(args[1]);
                    let records = match key {
                        "workflow_runs" => {
                            workflow_reads += 1;
                            let attempt = if retry || change.starts_with("lag_") || (workflow_reads > 1 && change != "children") { 2 } else { 1 };
                            if change == "unverifiable_provider" { vec![] } else { vec![serde_json::json!({"id":10,"check_suite_id":10,"run_attempt":attempt,"name":"CI",
                                "head_sha":"1111111111111111111111111111111111111111","status":"completed","conclusion":"failure"})] }
                        }
                        "check_suites" => vec![serde_json::json!({"id":10,"latest_check_runs_count":2,
                            "head_sha":"1111111111111111111111111111111111111111","status":"completed","conclusion":"failure"})],
                        "check_runs" => {
                            child_reads += 1;
                            let build = if retry || (child_reads > 1 && matches!(change, "children" | "both")) { "failure" } else { "success" };
                            ["build", "optional"].iter().enumerate().map(|(i, name)| serde_json::json!({
                                "id":i+1,"name":name,"head_sha":"1111111111111111111111111111111111111111",
                                "check_suite":{"id":10},"status":"completed","conclusion":if i == 0 { build } else { "failure" }
                            })).collect()
                        }
                        "jobs" => ["build", "optional"].iter().enumerate().map(|(i, name)| serde_json::json!({
                            "id":i+1,"run_id":10,"name":name,"head_sha":"1111111111111111111111111111111111111111",
                            "status":"completed","conclusion":if i == 0 && !retry && !change.starts_with("lag_") { "success" } else { "failure" },
                            "check_run_url":format!("https://api.github.com/repos/acme/widgets/check-runs/{}", if change == "lag_ids" && !retry { i+101 } else { i+1 })
                        })).collect(),
                        _ => vec![],
                    };
                    Ok(serde_json::json!([{"total_count":records.len(),key:records}]).to_string())
                }, |_, _| Ok(output(true, "[]", ""))).unwrap();
                let verdict = merge_verdict(&pr.head_sha);
                let result = gate::decide(&Facts { auto_merge:true, require_person:false, cloud:false, verdict:Some(&verdict), pr:&pr,
                    security_areas:&[], protected:&[], ignored_checks:&["optional".into()], allow_no_ci:false, checks_vouched:false });
                if retry {
                    assert_eq!(result, Gate::NeedsYou(StopReason::ChecksFailed { names: vec!["build".into()] }), "{change}");
                } else if change == "unverifiable_provider" {
                    assert!(matches!(result, Gate::NeedsYou(StopReason::ChecksFailed { .. })), "{result:?}");
                } else {
                    assert!(matches!(result, Gate::Wait(Wait::Checks(_))), "{change}: {result:?}");
                }
            }
        }
    }

    #[test]
    fn workflow_api_errors_and_unknown_payloads_never_become_validation() {
        for message in ["Resource not accessible by integration", "HTTP 502: Bad Gateway"] {
            let result = pr_snapshot_with(Path::new("/repo"), 7, |_, args| {
                if args[0] == "api" && args[1].contains("actions/runs") { bail!("{message}"); }
                Ok(if args[0] == "api" { snapshot_validation(args) } else { OPEN_PR.into() })
            }, |_, _| Ok(output(true, "[]", "")));
            if not_permitted(message) {
                let pr = result.unwrap();
                assert!(pr.checks_unread);
                assert!(pr.validation.is_none());
            } else {
                assert!(result.is_err());
            }
        }
        assert_eq!(validation_state(&serde_json::json!({"status":"success","conclusion":"success"})).unwrap(), "pending");
        assert!(parse_required_checks(&output(true, r#"[{"name":null}]"#, "")).is_err());
    }

    #[test]
    fn a_head_moving_during_evidence_collection_does_not_inherit_validation() {
        let mut views = 0;
        let pr = pr_snapshot_with(Path::new("/repo"), 7, |_, args| {
            if args[0] == "api" { return Ok(snapshot_validation(args)); }
            views += 1;
            Ok(if views == 1 { OPEN_PR.into() } else { OPEN_PR.replace("1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222") })
        }, |_, _| Ok(output(true, "[]", ""))).unwrap();
        assert_eq!(pr.head_sha, "2222222222222222222222222222222222222222");
        assert_eq!(pr.validation, None);
    }

    #[test]
    fn a_snapshot_binds_the_checks_to_the_head_commit_and_asks_what_is_required() {
        let cwd = Path::new("/repo");
        let snapshot = pr_snapshot_with(
            cwd,
            7,
            |_, args| {
                if args[0] == "api" { return Ok(snapshot_validation(args)); }
                if args[4] == "headRefOid" { return Ok(OPEN_PR.into()); }
                assert_eq!(&args[..3], ["pr", "view", "7"]);
                assert!(args[4].contains("headRefOid") && args[4].contains("mergeStateStatus") && args[4].contains("statusCheckRollup"));
                Ok(OPEN_PR.into())
            },
            |_, args| {
                assert_eq!(args, ["pr", "checks", "7", "--required", "--json", "name"]);
                Ok(output(false, r#"[{"name":"build"}]"#, ""))
            },
        )
        .unwrap();
        assert_eq!(snapshot.head_sha, "1111111111111111111111111111111111111111");
        assert_eq!(snapshot.merge_state, "UNSTABLE");
        assert_eq!(snapshot.checks.len(), 2);
        assert_eq!(snapshot.checks[1].state, "in_progress");
        assert_eq!(snapshot.required_checks, Some(vec!["build".to_string()]));
        assert_eq!((snapshot.base.as_str(), snapshot.head.as_str()), ("main", "raccoon/x"));

        // A merged pull request is not asked about checks nobody will wait for.
        let merged = pr_snapshot_with(cwd, 7, |_, _| Ok(OPEN_PR.replace("\"OPEN\"", "\"MERGED\"")), |_, _| panic!("no checks call for a merged pull request")).unwrap();
        assert_eq!(merged.state, "MERGED");
        // No head commit, no snapshot: nothing can be pinned to it.
        assert!(pr_snapshot_with(cwd, 7, |_, _| Ok(r#"{"number":7,"state":"OPEN"}"#.into()), |_, _| Ok(output(true, "[]", ""))).is_err());
    }

    #[test]
    fn a_token_that_may_not_read_the_checks_still_reads_the_pull_request_and_says_its_checks_are_unread() {
        let cwd = Path::new("/repo");
        let refused = "GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)";
        let mut asked = Vec::new();
        let snapshot = pr_snapshot_with(
            cwd,
            7,
            |_, args| {
                asked.push(args[4].to_string());
                if args[4].contains("statusCheckRollup") { bail!("{refused}") } else { Ok(OPEN_PR.into()) }
            },
            |_, _| panic!("checks that cannot be read are not asked about again"),
        )
        .unwrap();
        assert!(snapshot.checks_unread);
        assert!(!asked[1].contains("statusCheckRollup") && asked[1].contains("headRefOid") && asked[1].contains("mergeStateStatus"));
        assert_eq!((snapshot.head_sha.as_str(), snapshot.mergeable.as_str(), snapshot.required_checks.clone()), ("1111111111111111111111111111111111111111", "MERGEABLE", None));
        // The required checks alone refused: the checks read are not taken for the whole story.
        let partly = pr_snapshot_with(cwd, 7, |_, _| Ok(OPEN_PR.into()), |_, _| Ok(output(false, "", refused))).unwrap();
        assert!(partly.checks_unread && partly.checks.is_empty());
        // Any other failure is a failure.
        assert!(pr_snapshot_with(cwd, 7, |_, _| bail!("HTTP 502: Bad Gateway"), |_, _| Ok(output(true, "[]", ""))).is_err());
        assert!(!pr_snapshot_with(cwd, 7, |_, args| Ok(if args[0] == "api" { snapshot_validation(args) } else { OPEN_PR.into() }), |_, _| Ok(output(true, "[]", ""))).unwrap().checks_unread);
    }

    #[test]
    fn the_open_pull_request_of_a_branch_is_this_repositorys_and_asks_for_no_checks() {
        let found = open_pr_for_branch_with(Path::new("/repo"), "raccoon/x", |_, args| {
            assert_eq!(args, ["pr", "list", "--head", "raccoon/x", "--state", "open", "--json", "number,isCrossRepository", "--limit", "100"]);
            Ok(r#"[{"number":9,"isCrossRepository":true},{"number":7,"isCrossRepository":false}]"#.into())
        });
        assert_eq!(found.unwrap(), Some(7));
        assert_eq!(open_pr_for_branch_with(Path::new("/repo"), "b", |_, _| Ok("[]".into())).unwrap(), None);
    }

    #[test]
    fn a_pinned_merge_passes_the_commit_and_reads_the_result_from_the_pull_request() {
        let cwd = Path::new("/repo");
        let head = "1111111111111111111111111111111111111111";
        let next = "2222222222222222222222222222222222222222";
        let at = |state: &str, sha: &str| -> Result<PrSnapshot> {
            let mut snapshot = parse_snapshot(&serde_json::from_str(OPEN_PR).unwrap());
            snapshot.state = state.into();
            snapshot.head_sha = sha.into();
            Ok(snapshot)
        };
        let merged = merge_pr_at_with(
            cwd,
            7,
            "squash",
            head,
            |_, args| {
                assert_eq!(args, ["pr", "merge", "7", "--squash", "--match-head-commit", head]);
                assert!(!args.contains(&"--admin") && !args.contains(&"--auto"));
                Ok(output(true, "", ""))
            },
            |_, _| at("MERGED", head),
        )
        .unwrap();
        assert_eq!(merged, PinnedMerge::Merged);
        // The head moved between the decision and the merge: GitHub refuses, and it is said as that.
        let moved = merge_pr_at_with(cwd, 7, "merge", head, |_, _| Ok(output(false, "", "Head branch was modified. Review and try the merge again.")), |_, _| at("OPEN", next)).unwrap();
        assert_eq!(moved, PinnedMerge::HeadMoved { head: next.into() });
        // Branch protection refusing is GitHub's to explain.
        let refused = merge_pr_at_with(cwd, 7, "merge", head, |_, _| Ok(output(false, "", "Pull request is not mergeable: the base branch policy prohibits the merge.")), |_, _| at("OPEN", head)).unwrap();
        assert_eq!(refused, PinnedMerge::Refused("Pull request is not mergeable: the base branch policy prohibits the merge.".into()));
        // A failure report after the merge went through is still a merge.
        assert_eq!(merge_pr_at_with(cwd, 7, "merge", head, |_, _| Ok(output(false, "", "timeout")), |_, _| at("MERGED", head)).unwrap(), PinnedMerge::Merged);
        // A merge queue takes the request and merges later.
        assert_eq!(merge_pr_at_with(cwd, 7, "merge", head, |_, _| Ok(output(true, "", "")), |_, _| at("OPEN", head)).unwrap(), PinnedMerge::Accepted);
        // Taken, and not readable back: still taken, for the next look to settle.
        assert_eq!(merge_pr_at_with(cwd, 7, "merge", head, |_, _| Ok(output(true, "", "")), |_, _| bail!("HTTP 502")).unwrap(), PinnedMerge::Accepted);
    }

    #[test]
    fn a_pull_request_named_by_its_link_is_asked_for_in_its_own_repository() {
        assert_eq!(pr_url_parts("https://github.com/acme/widgets/pull/433"), Some(("acme/widgets".into(), 433)));
        assert_eq!(pr_url_parts("https://github.com/acme/my.repo_2/pull/7/\n"), Some(("acme/my.repo_2".into(), 7)));
        for not_one in ["https://github.com/acme/widgets/issues/433", "https://github.com/acme/widgets/pull/433/files", "https://gitlab.com/acme/widgets/pull/1", "https://github.com/acme/widgets/pull/x", "https://github.com/acme/wid gets/pull/1", ""] {
            assert_eq!(pr_url_parts(not_one), None, "{not_one:?}");
        }
        // The repository goes after the arguments, so every call names it.
        assert_eq!(in_repo(&["pr", "merge", "7", "--merge", "--match-head-commit", "abc1234"], "acme/widgets"), ["pr", "merge", "7", "--merge", "--match-head-commit", "abc1234", "--repo", "acme/widgets"]);
        assert_eq!(in_repo(&["pr", "checks", "7", "--required", "--json", "name"], "acme/widgets"), ["pr", "checks", "7", "--required", "--json", "name", "--repo", "acme/widgets"]);
    }

    #[test]
    fn the_pull_requests_of_many_branches_are_asked_for_in_one_request() {
        let query = branch_prs_query(2);
        assert!(query.starts_with("query($owner:String!,$name:String!,$b0:String!,$b1:String!){repository(owner:$owner,name:$name){b0:pullRequests(headRefName:$b0,"), "{query}");
        assert!(query.contains("b1:pullRequests(headRefName:$b1,") && query.contains("headRefOid") && query.ends_with("}}"), "{query}");

        let branches = ["raccoon/merged".to_string(), "raccoon/none".to_string(), "raccoon/reopened".to_string(), "raccoon/forked".to_string()];
        let pr = |number: u64, state: &str, fork: bool| serde_json::json!({ "number": number, "title": "T", "url": format!("https://github.com/o/r/pull/{number}"), "state": state, "isCrossRepository": fork, "headRefOid": format!("{number:040x}"), "baseRefName": "main" });
        let out = serde_json::json!({ "data": { "repository": {
            "b0": { "nodes": [pr(9, "MERGED", false), pr(4, "CLOSED", false)] },
            "b1": { "nodes": [] },
            // A newer open one speaks for the branch, whatever merged before it.
            "b2": { "nodes": [pr(12, "MERGED", false), pr(11, "OPEN", false)] },
            // A fork's branch of the same name is not this branch.
            "b3": { "nodes": [pr(20, "MERGED", true)] },
        } } })
        .to_string();
        let found = parse_branch_prs(&out, &branches).unwrap();
        assert_eq!(found.len(), 2);
        let merged = &found["raccoon/merged"];
        assert_eq!((merged.number, merged.state.as_str(), merged.head.as_str(), merged.base.as_str()), (9, "MERGED", format!("{:040x}", 9).as_str(), "main"));
        assert_eq!((found["raccoon/reopened"].number, found["raccoon/reopened"].state.as_str()), (11, "OPEN"));

        // No repository, or no answer for a branch, is not "no pull request".
        assert!(parse_branch_prs(r#"{"data":{"repository":null}}"#, &branches).is_err());
        assert!(parse_branch_prs(r#"{"data":{"repository":{"b0":{"nodes":[]}}}}"#, &branches).is_err());
    }

    #[test]
    fn a_branch_pull_request_says_which_issues_it_closes() {
        let query = branch_pr_issues_query(1);
        assert!(query.contains("b0:pullRequests(headRefName:$b0,") && query.contains("closingIssuesReferences(first:10){nodes{number repository{nameWithOwner}}}"), "{query}");
        let branches = ["raccoon/441-work".to_string(), "raccoon/none".to_string()];
        let out = serde_json::json!({ "data": { "repository": {
            "b0": { "nodes": [
                { "number": 3, "state": "CLOSED", "isCrossRepository": false, "title": "Old", "body": "", "closingIssuesReferences": { "nodes": [] } },
                { "number": 5, "state": "OPEN", "isCrossRepository": false, "title": "Work status (ENG-42)", "body": "Fixes #441", "closingIssuesReferences": { "nodes": [{ "number": 441, "repository": { "nameWithOwner": "acme/widgets" } }] } },
            ] },
            "b1": { "nodes": [] },
        } } })
        .to_string();
        let found = parse_branch_pr_issues(&out, &branches).unwrap();
        assert_eq!(found.len(), 1);
        let pr = &found["raccoon/441-work"];
        assert_eq!((pr.state.as_str(), pr.title.as_str(), pr.closes.clone()), ("OPEN", "Work status (ENG-42)", vec![("acme/widgets".to_string(), 441)]));
        assert!(parse_branch_pr_issues(r#"{"data":{"repository":null}}"#, &branches).is_err());
    }

    #[test]
    fn the_repository_and_its_head_branch_setting_are_read_from_what_github_says() {
        let repo = parse_repo_ref(r#"{"name":"app","owner":{"id":"x","login":"acme"},"url":"https://github.example.com/acme/app"}"#).unwrap();
        assert_eq!(repo, RepoRef { host: "github.example.com".into(), owner: "acme".into(), name: "app".into() });
        assert!(parse_repo_ref(r#"{"name":"app","owner":{},"url":""}"#).is_err());

        let on = parse_head_branch_setting(r#"{"full_name":"acme/app","delete_branch_on_merge":true,"permissions":{"admin":true}}"#).unwrap();
        assert_eq!(on, HeadBranchSetting { repository: "acme/app".into(), enabled: Some(true), admin: true });
        // GitHub leaves the setting out for a reader who may not see it.
        let hidden = parse_head_branch_setting(r#"{"full_name":"acme/app","permissions":{"admin":false,"push":true}}"#).unwrap();
        assert_eq!((hidden.enabled, hidden.admin), (None, false));
    }

    #[test]
    fn parses_rollup_shapes() {
        let v: Value = serde_json::json!({
            "number": 7, "title": "T", "url": "u", "state": "OPEN", "isDraft": false,
            "baseRefName": "main", "headRefName": "raccoon/x", "additions": 3, "deletions": 1,
            "mergeable": "MERGEABLE", "reviewDecision": "",
            "statusCheckRollup": [
                {"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS"},
                {"__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": ""},
                {"__typename": "StatusContext", "context": "ci/cla", "state": "PENDING"}
            ],
            "body": "", "author": {"login": "me"}
        });
        let pr = parse_pr(&v);
        assert_eq!(pr.checks.len(), 3);
        assert_eq!(pr.checks[0].state, "success");
        assert_eq!(pr.checks[1].state, "in_progress");
        assert_eq!(pr.checks[2].name, "ci/cla");
        assert_eq!(pr.checks[2].state, "pending");
        assert!(pr.review_decision.is_none());
    }
}

/// Compiled from src/lib/repo.ts, also used by the system-browser fallback.
pub const REPO_URL: &str = env!("TERMINALX_REPO_URL");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StarStatus { Starred, NotStarred, Unknown }

fn star_query() -> String {
    let slug = REPO_URL.strip_prefix("https://github.com/").expect("GitHub homepage");
    let (owner, name) = slug.split_once('/').expect("owner/repository");
    format!("query={{repository(owner:{},name:{}){{viewerHasStarred}}}}", serde_json::json!(owner), serde_json::json!(name))
}

fn parse_star_status(success: bool, output: &[u8]) -> StarStatus {
    if !success { return StarStatus::Unknown; }
    let Ok(value) = serde_json::from_slice::<Value>(output) else { return StarStatus::Unknown; };
    if value.get("errors").is_some() { return StarStatus::Unknown; }
    match value["data"]["repository"]["viewerHasStarred"].as_bool() {
        Some(true) => StarStatus::Starred,
        Some(false) => StarStatus::NotStarred,
        None => StarStatus::Unknown,
    }
}

async fn star_request(command: Command, args: &[&str]) -> Option<std::process::Output> {
    let mut command = tokio::process::Command::from(command);
    command.args(args).kill_on_drop(true);
    tokio::time::timeout(std::time::Duration::from_secs(15), command.output()).await.ok()?.ok()
}

pub async fn star_status() -> StarStatus {
    let Ok(command) = gh() else { return StarStatus::Unknown; };
    star_status_with(command).await
}

async fn star_status_with(command: Command) -> StarStatus {
    let query = star_query();
    // Pin github.com even when the user's gh default host is an enterprise host.
    match star_request(command, &["api", "--hostname", "github.com", "graphql", "-f", &query]).await {
        Some(out) => parse_star_status(out.status.success(), &out.stdout),
        None => StarStatus::Unknown,
    }
}

pub async fn star_repository() -> bool {
    let Ok(command) = gh() else { return false; };
    star_repository_with(command).await
}

async fn star_repository_with(command: Command) -> bool {
    let endpoint = format!("user/starred/{}", REPO_URL.strip_prefix("https://github.com/").expect("GitHub homepage"));
    star_request(command, &["api", "--hostname", "github.com", "--method", "PUT", &endpoint]).await.is_some_and(|out| out.status.success())
}

#[cfg(test)]
mod star_tests {
    use super::*;

    #[test]
    fn star_lookup_keeps_explicit_false_separate_from_errors() {
        for (success, response, expected) in [
            (true, r#"{"data":{"repository":{"viewerHasStarred":true}}}"#, StarStatus::Starred),
            (true, r#"{"data":{"repository":{"viewerHasStarred":false}}}"#, StarStatus::NotStarred),
            (true, r#"{"data":{"repository":null}}"#, StarStatus::Unknown),
            (true, r#"{"errors":[{"message":"denied"}],"data":{"repository":{"viewerHasStarred":false}}}"#, StarStatus::Unknown),
            (false, r#"{"data":{"repository":{"viewerHasStarred":false}}}"#, StarStatus::Unknown),
            (true, "garbage", StarStatus::Unknown),
            (false, "HTTP 404", StarStatus::Unknown),
        ] { assert_eq!(parse_star_status(success, response.as_bytes()), expected); }
    }

    #[cfg(unix)]
    fn process(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script, "star-test"]);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn star_cli_boundary_pins_host_repository_and_method() {
        assert_eq!(REPO_URL, "https://github.com/terminalx-ai/raccoon");
        let command = process(r#"
            test "$1" = api && test "$2" = --hostname && test "$3" = github.com &&
            test "$4" = graphql && test "$5" = -f &&
            test "$6" = 'query={repository(owner:"terminalx-ai",name:"raccoon"){viewerHasStarred}}' || exit 1
            printf '%s' '{"data":{"repository":{"viewerHasStarred":false}}}'
        "#);
        assert_eq!(star_status_with(command).await, StarStatus::NotStarred);
        let command = process(r#"
            test "$1" = api && test "$2" = --hostname && test "$3" = github.com &&
            test "$4" = --method && test "$5" = PUT && test "$6" = user/starred/terminalx-ai/raccoon
        "#);
        assert!(star_repository_with(command).await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_process_authentication_and_mutation_errors_are_recoverable() {
        assert_eq!(star_status_with(Command::new("/nonexistent/gh")).await, StarStatus::Unknown);
        assert_eq!(star_status_with(process("exit 4")).await, StarStatus::Unknown);
        assert!(!star_repository_with(process("exit 1")).await);
        assert!(!star_repository_with(Command::new("/nonexistent/gh")).await);
    }
}
