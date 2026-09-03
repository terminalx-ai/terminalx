//! Pull requests through the `gh` CLI, which already holds auth and host
//! configuration. Absent `gh` is one readable line, not a broken panel.

use std::path::Path;
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

fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = gh()?.current_dir(cwd).args(args).output().with_context(|| format!("gh {}", args.join(" ")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!("{}", if err.is_empty() { format!("gh {} failed", args.join(" ")) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

const FIELDS: &str = "number,title,url,state,isDraft,baseRefName,headRefName,additions,deletions,mergeable,reviewDecision,statusCheckRollup,body,author";

fn parse_pr(v: &Value) -> PullRequest {
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
    let out = run(cwd, &["pr", "list", "--head", branch, "--state", "all", "--json", FIELDS, "--limit", "10"])?;
    let v: Value = serde_json::from_str(&out)?;
    let mut prs: Vec<PullRequest> = v.as_array().map(|a| a.iter().map(parse_pr).collect()).unwrap_or_default();
    prs.sort_by(|a, b| (b.state == "OPEN").cmp(&(a.state == "OPEN")).then(b.number.cmp(&a.number)));
    Ok(prs)
}

pub fn create_pr(cwd: &Path, title: &str, body: &str, base: Option<&str>, draft: bool) -> Result<String> {
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
    }
    Ok(url)
}

pub fn merge_pr(cwd: &Path, number: u64, method: &str) -> Result<()> {
    let n = number.to_string();
    let flag = match method {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
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
