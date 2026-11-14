//! One inexpensive GraphQL query for the session-associated PRs in a project.
use super::*;
use std::collections::HashMap;
use std::time::Duration;

pub(crate) const POLL_INTERVAL: Duration = Duration::from_secs(120);
pub(crate) const FRESH_FOR: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RowPr {
    pub branch: String,
    pub pr: BranchPr,
}

pub(crate) struct Poll {
    pub prs: Result<HashMap<String, RowPr>>,
    pub retry_after: Duration,
    pub limited: bool,
}

// Direct PR lookups have no pullRequests connection. Only one last-commit
// connection per known PR is charged; cleanup keeps its lightweight query.
fn query(count: usize) -> String {
    let variables: String = (0..count).map(|i| format!(",$p{i}:Int!")).collect();
    let fields = "number title url state headRefName isCrossRepository headRefOid baseRefName isDraft mergeable mergeStateStatus mergeQueueEntry{id} commits(last:1){nodes{commit{statusCheckRollup{state}}}}";
    let aliases: String = (0..count).map(|i| format!("p{i}:pullRequest(number:$p{i}){{{fields}}}")).collect();
    format!("query($owner:String!,$name:String!{variables}){{repository(owner:$owner,name:$name){{{aliases}}} rateLimit{{cost limit remaining resetAt}}}}")
}

pub(crate) fn poll(cwd: &Path, urls: &[String]) -> Poll {
    #[cfg(test)]
    let result: Result<(std::process::Output, Vec<String>)> = {
        let _ = (cwd, urls);
        Err(anyhow!("No row PR response installed for this test"))
    };
    #[cfg(not(test))]
    let result: Result<(std::process::Output, Vec<String>)> = (|| {
        let repo = repo_ref(cwd)?;
        let prefix = format!("https://{}/{}/{}/pull/", repo.host, repo.owner, repo.name).to_lowercase();
        let urls: Vec<_> = urls.iter().filter_map(|url| crate::pr_associations::identity(url).ok()).filter(|url| url.starts_with(&prefix)).collect::<BTreeSet<_>>().into_iter().collect();
        // Foreign/unavailable associations stay unknown to the row reader.
        if urls.is_empty() { return Err(anyhow!("No associated PR in this repository")); }
        let mut command = gh()?;
        command.current_dir(cwd).args(["api", "graphql", "--include", "--hostname", &repo.host])
            .args(["-f", &format!("query={}", query(urls.len())), "-f", &format!("owner={}", repo.owner), "-f", &format!("name={}", repo.name)])
            .env("GH_NO_UPDATE_NOTIFIER", "1");
        for (i, url) in urls.iter().enumerate() { command.args(["-F", &format!("p{i}={}", url.rsplit('/').next().unwrap())]); }
        Ok((output_within(command, BOUNDED)?, urls))
    })();
    match result {
        Ok((out, urls)) => parse(&String::from_utf8_lossy(&out.stdout), out.status.success(), chrono::Utc::now(), &urls),
        Err(error) => Poll { prs: Err(error), retry_after: POLL_INTERVAL, limited: false },
    }
}

fn parse_prs(value: &Value, urls: &[String]) -> Result<HashMap<String, RowPr>> {
    let repository = &value["data"]["repository"];
    if !repository.is_object() { bail!("GitHub did not return the repository"); }
    urls.iter().enumerate().map(|(i, url)| {
        let value = &repository[format!("p{i}")];
        // The association proves ownership, including a PR from a fork. The
        // cross-repository filter belongs only to branch-name discovery.
        let pr = parse_branch_pr(value).context("GitHub did not return the associated PR")?;
        if crate::pr_associations::identity(&pr.url)? != *url { bail!("GitHub returned a different PR"); }
        let branch = value["headRefName"].as_str().context("GitHub did not return the PR branch")?.to_string();
        Ok((url.clone(), RowPr { branch, pr }))
    }).collect()
}

fn parse(out: &str, success: bool, now: chrono::DateTime<chrono::Utc>, urls: &[String]) -> Poll {
    let normalized = out.replace("\r\n", "\n");
    let (headers, body) = normalized.split_once("\n\n").unwrap_or(("", &normalized));
    let status = headers.lines().next().and_then(|line| line.split_whitespace().nth(1)).and_then(|code| code.parse::<u16>().ok());
    let header = |key: &str| headers.lines().filter_map(|line| line.split_once(':')).find(|(name, _)| name.eq_ignore_ascii_case(key)).map(|(_, value)| value.trim());
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let budget = &value["data"]["rateLimit"];
    let remaining = header("x-ratelimit-remaining").and_then(|v| v.parse::<u64>().ok()).or_else(|| budget["remaining"].as_u64());
    let limit = header("x-ratelimit-limit").and_then(|v| v.parse::<u64>().ok()).or_else(|| budget["limit"].as_u64()).unwrap_or(5000);
    let reset = header("x-ratelimit-reset").and_then(|v| v.parse::<i64>().ok())
        .or_else(|| budget["resetAt"].as_str().and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok()).map(|v| v.timestamp()));
    let errors = value["errors"].as_array();
    // Never inspect PR data (especially titles) or arbitrary response text.
    let limited = status == Some(429) || header("retry-after").is_some() || remaining == Some(0)
        || errors.is_some_and(|errors| errors.iter().any(|error| error["type"] == "RATE_LIMITED" || error["extensions"]["type"] == "RATE_LIMITED"));
    let retry = header("retry-after").and_then(|v| v.parse::<u64>().ok().or_else(|| chrono::DateTime::parse_from_rfc2822(v).ok().map(|v| (v.timestamp() - now.timestamp()).max(0) as u64))).unwrap_or(0);
    // Keep at least 1,000 points / 20% for interactive tools. Also reserve the
    // cost of another batch so the next poll cannot consume that headroom.
    let reserve = 1000_u64.max(limit / 5).saturating_add(budget["cost"].as_u64().unwrap_or(1));
    let budget_low = remaining.is_some_and(|left| left <= reserve);
    let budget_wait = if budget_low { reset.map(|at| at.saturating_sub(now.timestamp()).saturating_add(1).max(0) as u64).unwrap_or(3600) } else { 0 };
    let retry_after = Duration::from_secs(retry.max(budget_wait).max(POLL_INTERVAL.as_secs()).min(7 * 24 * 3600));
    let prs = if !success || status.is_some_and(|code| code >= 400) || errors.is_some_and(|errors| !errors.is_empty()) {
        Err(anyhow!("GitHub PR status is temporarily unavailable"))
    } else { parse_prs(&value, urls) };
    Poll { prs, retry_after, limited: limited || budget_low }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn url() -> String { "https://github.com/o/r/pull/7".into() }
    fn pr() -> Value { json!({"number":7,"title":"Back off on GitHub rate limit / abuse detection","url":url(),"state":"OPEN","headRefName":"feature","isCrossRepository":false,"headRefOid":"abc","baseRefName":"main","isDraft":true,"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","mergeQueueEntry":{"id":"Q_1"},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE"}}}]}}) }
    fn response(pr: Value) -> Value { json!({"data":{"repository":{"p0":pr},"rateLimit":{"cost":1,"limit":5000,"remaining":4999}}}) }

    #[test]
    fn exact_pr_batch_has_only_one_connection_per_pr_and_cleanup_has_no_checks() {
        let text = query(100);
        assert!(text.contains("$p99:Int!") && text.contains("p99:pullRequest(number:$p99)"));
        assert!(!text.contains("pullRequests(") && !text.contains("first:"));
        assert_eq!(text.matches("commits(last:1)").count(), 100);
        assert!(!branch_prs_query(100).contains("commits("));
        let mut depth = 0;
        for c in text.chars() { if c == '{' { depth += 1; } else if c == '}' { depth -= 1; } assert!(depth >= 0); }
        assert_eq!(depth, 0);
    }

    #[test]
    fn successful_titles_do_not_limit_polling_and_head_facts_are_parsed() {
        let result = parse(&response(pr()).to_string(), true, chrono::Utc::now(), &[url()]);
        assert!(!result.limited);
        assert_eq!(result.retry_after, POLL_INTERVAL);
        let parsed = &result.prs.unwrap()[&url()];
        assert_eq!(parsed.branch, "feature");
        assert!(parsed.pr.draft && parsed.pr.in_merge_queue);
        assert_eq!(parsed.pr.head, "abc");
        assert_eq!(parsed.pr.checks.as_deref(), Some("FAILURE"));
        let mut without = pr();
        without["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = Value::Null;
        assert_eq!(parse_prs(&response(without.clone()), &[url()]).unwrap()[&url()].pr.checks, None);
        without["commits"]["nodes"] = json!([]);
        assert_eq!(parse_prs(&response(without), &[url()]).unwrap()[&url()].pr.checks.as_deref(), Some("UNKNOWN"));
        assert!(parse_prs(&response(Value::Null), &[url()]).is_err());
    }

    #[test]
    fn an_associated_fork_pr_does_not_discard_the_project_batch() {
        let mut fork = pr();
        fork["isCrossRepository"] = json!(true);
        // Branch-name discovery still cannot claim somebody else's fork.
        assert!(pick_pr(std::slice::from_ref(&fork)).is_none());
        let other_url = "https://github.com/o/r/pull/8".to_string();
        let mut other = pr();
        other["number"] = json!(8);
        other["url"] = Value::String(other_url.clone());
        let mut body = response(fork);
        body["data"]["repository"]["p1"] = other;
        let result = parse_prs(&body, &[url(), other_url.clone()]).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[&url()].pr.number, 7);
        assert_eq!(result[&other_url].pr.number, 8);
    }

    #[test]
    fn only_structured_limits_pause_and_reserve_is_shared_with_other_tools() {
        let now = chrono::Utc::now();
        for out in ["HTTP/2.0 429 Too Many Requests\n\n{}", "HTTP/2.0 403 Forbidden\nRetry-After: 150\n\n{}", r#"{"errors":[{"type":"RATE_LIMITED","message":"limited"}]}"#] {
            let result = parse(out, false, now, &[]);
            assert!(result.limited && result.prs.is_err());
        }
        assert!(!parse("HTTP/2.0 403 Forbidden\n\n{}", false, now, &[]).limited);
        let mut body = response(pr());
        body["data"]["rateLimit"]["remaining"] = json!(1001);
        body["data"]["rateLimit"]["resetAt"] = json!((now + chrono::Duration::minutes(20)).to_rfc3339());
        let low = parse(&body.to_string(), true, now, &[url()]);
        assert!(low.prs.is_ok() && low.limited);
        assert_eq!(low.retry_after, Duration::from_secs(1201));
        body["data"]["rateLimit"]["resetAt"] = json!((now - chrono::Duration::seconds(5)).to_rfc3339());
        let skewed = parse(&body.to_string(), true, now, &[url()]);
        assert!(skewed.limited);
        assert_eq!(skewed.retry_after, POLL_INTERVAL);
    }
}
