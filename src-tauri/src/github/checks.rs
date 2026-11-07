//! Actions check logs and reruns. Every command names the PR's repository:
//! a session can retain PRs from several repositories with overlapping IDs.
use std::collections::{BTreeMap, VecDeque};
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const LOG_LIMIT: usize = 256 * 1024;
const TRIMMED: &str = "[Earlier log output trimmed to fit the size limit]\n";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsCheck {
    pub run_id: u64,
    pub job_id: Option<u64>,
}

/// Only Actions URLs in the PR's exact repository count. A third party's
/// check ID (or a job ID by itself) must never be treated as an Actions run ID.
pub fn map_check(pr_url: &str, details_url: &str) -> Option<ActionsCheck> {
    let pr = url::Url::parse(&crate::pr_associations::identity(pr_url).ok()?).ok()?;
    let details = url::Url::parse(details_url).ok()?;
    if details.scheme() != "https" || details.origin() != pr.origin()
        || !details.username().is_empty() || details.password().is_some() {
        return None;
    }
    let pr_parts: Vec<_> = pr.path().trim_matches('/').split('/').collect();
    let parts: Vec<_> = details.path().trim_matches('/').split('/').collect();
    if parts.len() < 5 || !parts[0].eq_ignore_ascii_case(pr_parts[0])
        || !parts[1].eq_ignore_ascii_case(pr_parts[1]) || parts[2..4] != ["actions", "runs"] {
        return None;
    }
    let positive = |value: &str| value.parse::<u64>().ok().filter(|n| *n > 0);
    let run_id = positive(parts[4])?;
    let job_id = match &parts[5..] {
        [] => None,
        ["job", job] => Some(positive(job)?),
        ["attempts", attempt] => { positive(attempt)?; None }
        ["attempts", attempt, "job", job] => { positive(attempt)?; Some(positive(job)?) }
        _ => return None,
    };
    Some(ActionsCheck { run_id, job_id })
}

fn repository(pr_url: &str) -> Result<String> {
    let identity = crate::pr_associations::identity(pr_url)?;
    let url = url::Url::parse(&identity)?;
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    // No URL decoding, options, or API path components can enter gh arguments.
    if parts[..2].iter().any(|s| !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))) {
        bail!("Invalid GitHub repository");
    }
    Ok(format!("{}/{}/{}", &url[url::Position::BeforeHost..url::Position::AfterPort], parts[0], parts[1]))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckLog {
    pub text: String,
    pub truncated: bool,
}

/// Keep the tail, where failures and their summaries usually are, at a UTF-8
/// boundary. The marker counts toward the limit too.
pub fn trim_log(text: &str, limit: usize) -> CheckLog {
    if text.len() <= limit { return CheckLog { text: text.into(), truncated: false }; }
    let marker = &TRIMMED[..TRIMMED.len().min(limit)];
    let mut start = text.len() - limit.saturating_sub(marker.len());
    while !text.is_char_boundary(start) { start += 1; }
    CheckLog { text: format!("{marker}{}", &text[start..]), truncated: true }
}

/// Drain the whole pipe but retain bounded memory, even for multi-gigabyte
/// workflow output. Invalid UTF-8 is replaced before applying the final cap.
fn read_tail(mut pipe: impl Read, limit: usize) -> std::io::Result<CheckLog> {
    let mut tail = VecDeque::with_capacity(limit);
    let mut truncated = false;
    let mut chunk = [0; 8192];
    loop {
        let n = pipe.read(&mut chunk)?;
        if n == 0 { break; }
        let excess = (tail.len() + n).saturating_sub(limit);
        truncated |= excess > 0;
        tail.drain(..excess.min(tail.len()));
        tail.extend(&chunk[n.saturating_sub(limit)..n]);
    }
    let bytes: Vec<_> = tail.into();
    let text = String::from_utf8_lossy(&bytes);
    let mut log = if truncated { trim_log(&format!("{TRIMMED}{text}"), limit) } else { trim_log(&text, limit) };
    log.truncated |= truncated;
    Ok(log)
}

fn run_log(cwd: &Path, args: &[&str]) -> Result<CheckLog> {
    let mut command = super::gh()?;
    command.current_dir(cwd).args(args);
    log_output(command, super::GH_TIMEOUT)
}

fn log_output(mut command: std::process::Command, timeout: std::time::Duration) -> Result<CheckLog> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child.stdout.take().context("Missing gh output pipe")?;
    let stderr = child.stderr.take().context("Missing gh error pipe")?;
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let (err_tx, err_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let _ = out_tx.send(read_tail(stdout, LOG_LIMIT)); });
    std::thread::spawn(move || { let _ = err_tx.send(read_tail(stderr, 16 * 1024)); });
    let deadline = std::time::Instant::now() + timeout;
    let result = (|| -> Result<_> {
        let status = loop {
            match child.try_wait()? {
                Some(status) => break status,
                None if std::time::Instant::now() >= deadline => bail!("Timed out waiting for GitHub check logs."),
                None => std::thread::sleep(std::time::Duration::from_millis(25)),
            }
        };
        // Helpers can retain the pipes after gh exits. Collection has the same
        // deadline, so a log viewer can never wait indefinitely on a join.
        let log = out_rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).context("Timed out reading GitHub check logs")??;
        let error = err_rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).context("Timed out reading GitHub's error")??;
        if !status.success() {
            bail!("{}", if error.text.trim().is_empty() { "GitHub could not load the check logs." } else { error.text.trim() });
        }
        Ok(log)
    })();
    if result.is_err() {
        #[cfg(unix)]
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn log_args(repo: &str, check: &ActionsCheck, failed: bool) -> Vec<String> {
    let mut args = vec!["run".into(), "view".into(), check.run_id.to_string(), "--repo".into(), repo.into(), if failed { "--log-failed".into() } else { "--log".into() }];
    if let Some(job) = check.job_id { args.extend(["--job".into(), job.to_string()]); }
    args
}

pub fn log(_cwd: &Path, pr_url: &str, check_url: &str, failed: bool) -> Result<CheckLog> {
    let check = map_check(pr_url, check_url).context("This check is not a GitHub Actions run in this PR's repository.")?;
    let args = log_args(&repository(pr_url)?, &check, failed);
    // Retained session PRs outlive deleted worktrees. With --repo pinned,
    // these calls need no checkout, just as associated PR reads do.
    run_log(&super::outside_checkouts(), &args.iter().map(String::as_str).collect::<Vec<_>>())
}

pub fn rerun(_cwd: &Path, pr_url: &str, check_url: &str, failed: bool) -> Result<()> {
    rerun_with(&super::outside_checkouts(), pr_url, check_url, failed, super::run)
}

fn rerun_with(cwd: &Path, pr_url: &str, check_url: &str, failed: bool, mut run: impl FnMut(&Path, &[&str]) -> Result<String>) -> Result<()> {
    let check = map_check(pr_url, check_url).context("This check is not a GitHub Actions run in this PR's repository.")?;
    let identity = crate::pr_associations::identity(pr_url)?;
    let number = identity.rsplit('/').next().context("Invalid pull request URL")?;
    let repo = repository(pr_url)?;
    let id = check.run_id.to_string();
    // A commit status can link to any run in this repository, including a
    // deployment on main. Resolve the run's immutable commit before reading
    // the PR's current head, immediately ahead of the outward action.
    let target: serde_json::Value = serde_json::from_str(&run(cwd, &["run", "view", &id, "--repo", &repo, "--json", "databaseId,headSha"])?)?;
    if target["databaseId"].as_u64() != Some(check.run_id) { bail!("GitHub returned a different Actions run."); }
    let run_head = target["headSha"].as_str().filter(|sha| !sha.is_empty()).context("GitHub omitted the Actions run's head commit.")?;
    let pr: serde_json::Value = serde_json::from_str(&run(cwd, &["pr", "view", number, "--repo", &repo, "--json", "url,state,headRefOid"])?)?;
    let returned_url = pr["url"].as_str().context("GitHub omitted the pull request URL.")?;
    if crate::pr_associations::identity(returned_url)? != identity { bail!("GitHub returned a different pull request."); }
    if pr["state"].as_str() != Some("OPEN") { bail!("This pull request is no longer open."); }
    let pr_head = pr["headRefOid"].as_str().filter(|sha| !sha.is_empty()).context("GitHub omitted the pull request's head commit.")?;
    if run_head != pr_head {
        bail!("This Actions run does not match the pull request's current head. Refresh the checks before re-running.");
    }
    let mut args = vec!["run", "rerun", &id, "--repo", &repo];
    if failed { args.push("--failed"); }
    run(cwd, &args)?;
    Ok(())
}

pub fn failing(state: &str) -> bool {
    matches!(state, "failure" | "error" | "cancelled" | "timed_out" | "action_required" | "startup_failure" | "stale")
}

/// Re-read GitHub before collecting, deduplicate jobs in the same run, and
/// share the budget between runs so one verbose job cannot hide all others.
pub fn failed_logs(cwd: &Path, pr_url: &str) -> Result<CheckLog> {
    let identity = crate::pr_associations::identity(pr_url)?;
    let number = identity.rsplit('/').next().unwrap().parse()?;
    let pr = super::associated_pr_details(cwd, number, Some(&identity))?;
    if crate::pr_associations::identity(&pr.url)? != identity { bail!("GitHub returned a different pull request."); }
    if pr.state != "OPEN" { bail!("This pull request is no longer open."); }
    collect_failed_logs(&pr, |run| {
        let args = log_args(&repository(pr_url)?, run, true);
        run_log(&super::outside_checkouts(), &args.iter().map(String::as_str).collect::<Vec<_>>())
    })
}

fn collect_failed_logs(pr: &super::PullRequest, mut load: impl FnMut(&ActionsCheck) -> Result<CheckLog>) -> Result<CheckLog> {
    let mut runs = BTreeMap::new();
    for check in &pr.checks {
        if !failing(&check.state) { continue; }
        if let Some(actions) = check.url.as_deref().and_then(|url| map_check(&pr.url, url)) {
            runs.entry(actions.run_id).or_insert(ActionsCheck { run_id: actions.run_id, job_id: None });
        }
    }
    if runs.is_empty() { bail!("This pull request has no failing GitHub Actions checks."); }
    if runs.len() > 20 { bail!("More than 20 Actions runs are failing. Open individual check logs on GitHub."); }
    let mut text = format!("Failed GitHub Actions logs for {}\n\n", pr.url);
    let budget = LOG_LIMIT.saturating_sub(text.len()) / runs.len();
    if budget < 1024 { bail!("The pull request details exceed the log size limit."); }
    let repo_url = pr.url.rsplit_once("/pull/").context("Invalid pull request URL")?.0;
    let mut truncated = false;
    for run in runs.values() {
        let header = format!("=== Actions run {} ===\n{repo_url}/actions/runs/{}\n", run.run_id, run.run_id);
        if header.len() + 2 > budget { bail!("The Actions run details exceed the log size limit."); }
        let log = load(run)?;
        let output = if log.text.trim().is_empty() { "No failed step log output was returned. Inspect the run on GitHub for cancellation or startup errors." } else { &log.text };
        let bounded = trim_log(output, budget - header.len() - 2);
        truncated |= log.truncated || bounded.truncated;
        text.push_str(&header);
        text.push_str(&bounded.text);
        text.push_str("\n\n");
    }
    Ok(CheckLog { text, truncated })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixAttachment {
    pub path: String,
    pub truncated: bool,
}

pub fn prepare_fix(session_id: &str, tab_id: &str, pr_url: &str) -> Result<FixAttachment> {
    // Resolve the actual session before building a path; arbitrary IDs cannot
    // become attachment directories, and shell tabs cannot receive prompts.
    let session = crate::store::index::get(session_id)?;
    let tab = session.tab(tab_id).context("The active agent tab is no longer available.")?;
    if tab.is_terminal() { bail!("Select an agent tab to fix check errors."); }
    let log = failed_logs(Path::new(&session.cwd), pr_url)?;
    let current = crate::store::index::get(session_id)?;
    if current.cwd != session.cwd || current.tab(tab_id).is_none_or(|tab| tab.is_terminal()) {
        bail!("The session or agent tab changed while loading check logs.");
    }
    let path = crate::store::attachments_dir(session_id)?.join(format!("check-failures-{}.log", uuid::Uuid::now_v7()));
    crate::store::write_atomic(&path, log.text.as_bytes())?;
    Ok(FixAttachment { path: path.to_string_lossy().into_owned(), truncated: log.truncated })
}

#[cfg(test)]
mod tests;
