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
                    let state = c["conclusion"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| c["state"].as_str())
                        .or_else(|| c["status"].as_str())
                        .unwrap_or("pending")
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

/// Every PR whose head is `branch`, open first then newest.
pub fn prs_for_branch(cwd: &Path, branch: &str) -> Result<Vec<PullRequest>> {
    prs_for_branch_with(cwd, branch, run)
}

fn prs_for_branch_with(cwd: &Path, branch: &str, run: impl FnOnce(&Path, &[&str]) -> Result<String>) -> Result<Vec<PullRequest>> {
    let out = run(cwd, &["pr", "list", "--head", branch, "--state", "all", "--json", FIELDS, "--limit", "1000"])?;
    let v: Value = serde_json::from_str(&out)?;
    let mut prs: Vec<PullRequest> = v.as_array().map(|a| a.iter().map(parse_pr).collect()).unwrap_or_default();
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

/// The pull request as the issue pipeline's merge gate reads it: one reply,
/// so the checks and the mergeability are those of `head_sha` and of no other
/// commit.
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
    /// The checks branch protection requires, by name. `None` when the base
    /// branch requires none, and then every reported check counts.
    #[serde(default)]
    pub required_checks: Option<Vec<String>>,
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
        let names: BTreeSet<String> = checks.iter().filter_map(|check| check["name"].as_str()).map(String::from).collect();
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

fn pr_snapshot_with(
    cwd: &Path,
    number: u64,
    run: impl FnOnce(&Path, &[&str]) -> Result<String>,
    run_output: impl FnOnce(&Path, &[&str]) -> Result<GhOutput>,
) -> Result<PrSnapshot> {
    let n = number.to_string();
    let out = run(cwd, &["pr", "view", &n, "--json", SNAPSHOT_FIELDS])?;
    let mut snapshot = parse_snapshot(&serde_json::from_str(&out)?);
    if snapshot.head_sha.is_empty() {
        bail!("GitHub did not say which commit pull request #{number} is at.");
    }
    // Only an open pull request has checks left to wait for.
    if snapshot.state == "OPEN" {
        snapshot.required_checks = parse_required_checks(&run_output(cwd, &["pr", "checks", &n, "--required", "--json", "name"])?)?;
    }
    Ok(snapshot)
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
        (true, Ok(_)) => Ok(PinnedMerge::Accepted),
        (true, Err(error)) => Err(error.context("The merge was accepted, but the pull request could not be read back.")),
        (false, Ok(pr)) if !pr.head_sha.eq_ignore_ascii_case(commit) => Ok(PinnedMerge::HeadMoved { head: pr.head_sha }),
        (false, _) => Ok(PinnedMerge::Refused(if merged.stderr.is_empty() { "GitHub refused the merge.".into() } else { merged.stderr })),
    }
}

pub fn merge_pr(cwd: &Path, number: u64, method: &str) -> Result<()> {
    let n = number.to_string();
    let flag = merge_flag(method);
    let result = run(cwd, &["pr", "merge", &n, flag]);
    if result.is_err() {
        // `gh pr merge` can fail with the merge already through; ask again.
        let out = run(cwd, &["pr", "view", &n, "--json", "state"])?;
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn a_snapshot_binds_the_checks_to_the_head_commit_and_asks_what_is_required() {
        let cwd = Path::new("/repo");
        let snapshot = pr_snapshot_with(
            cwd,
            7,
            |_, args| {
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
