//! Read-only row polling: one GraphQL request for all distinct visible branches.
//! Keep budget and retry advice with the response, including unsuccessful HTTP responses.
use super::*;
use std::collections::HashMap;
use std::time::Duration;

pub(crate) struct Poll {
    pub prs: Result<HashMap<String, BranchPr>>,
    pub retry_after: Duration,
    pub limited: bool,
}

pub(crate) fn poll(cwd: &Path, branches: &[String]) -> Poll {
    #[cfg(test)]
    let result: Result<std::process::Output> = {
        if let Some(prs) = stand_in::answer(cwd, branches) {
            return Poll { prs, retry_after: Duration::from_secs(30), limited: false };
        }
        Err(anyhow!("No PR response installed for this test"))
    };
    #[cfg(not(test))]
    let result: Result<std::process::Output> = (|| {
        let repo = repo_ref(cwd)?;
        let query = branch_prs_query(branches.len());
        let query = format!("{} rateLimit{{cost remaining resetAt}}}}", &query[..query.len() - 1]);
        let mut command = gh()?;
        command.current_dir(cwd).args(["api", "graphql", "--include", "--hostname", &repo.host])
            .args(["-f", &format!("query={query}"), "-f", &format!("owner={}", repo.owner), "-f", &format!("name={}", repo.name)])
            .env("GH_NO_UPDATE_NOTIFIER", "1");
        for (i, branch) in branches.iter().enumerate() { command.args(["-f", &format!("b{i}={branch}")]); }
        Ok(crate::git::capture_within(command, BOUNDED)?)
    })();
    match result {
        Ok(out) => parse(&String::from_utf8_lossy(&out.stdout), out.status.success(), &String::from_utf8_lossy(&out.stderr), chrono::Utc::now(), branches),
        Err(error) => {
            let message = error.to_string().to_lowercase();
            let limited = message.contains("rate limit") || message.contains("abuse detection");
            Poll { prs: Err(error), retry_after: Duration::from_secs(60), limited }
        },
    }
}

fn parse(out: &str, success: bool, error: &str, now: chrono::DateTime<chrono::Utc>, branches: &[String]) -> Poll {
    let normalized = out.replace("\r\n", "\n");
    let (headers, body) = normalized.split_once("\n\n").unwrap_or(("", &normalized));
    let header = |key: &str| headers.lines().filter_map(|line| line.split_once(':')).find(|(name, _)| name.eq_ignore_ascii_case(key)).map(|(_, value)| value.trim());
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let budget = &value["data"]["rateLimit"];
    let remaining = header("x-ratelimit-remaining").and_then(|v| v.parse::<u64>().ok()).or_else(|| budget["remaining"].as_u64());
    let reset = header("x-ratelimit-reset").and_then(|v| v.parse::<i64>().ok())
        .or_else(|| budget["resetAt"].as_str().and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok()).map(|v| v.timestamp()));
    let text = format!("{body} {error}").to_lowercase();
    let limited = header("retry-after").is_some() || remaining == Some(0) || text.contains("rate limit") || text.contains("rate_limit") || text.contains("abuse detection");
    let retry = header("retry-after").and_then(|v| v.parse::<u64>().ok().or_else(|| chrono::DateTime::parse_from_rfc2822(v).ok().map(|v| (v.timestamp() - now.timestamp()).max(0) as u64))).unwrap_or(0);
    // Leave headroom for interactive GitHub work. No query is made solely to read the budget.
    let budget_wait = if remaining.is_some_and(|left| left < 100) { reset.map(|at| at.saturating_sub(now.timestamp()).saturating_add(1).max(0) as u64).unwrap_or(3600) } else { 0 };
    let retry_after = Duration::from_secs(retry.max(budget_wait).max(if limited || !success { 60 } else { 30 }).min(7 * 24 * 3600));
    let prs = if !success || value["errors"].as_array().is_some_and(|errors| !errors.is_empty()) {
        Err(anyhow!("GitHub PR status is temporarily unavailable"))
    } else {
        parse_branch_prs(body, branches)
    };
    Poll { prs, retry_after, limited: limited || budget_wait > 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn query_batches_over_forty_branches_and_reads_the_head_rollup_and_queue() {
        let query = branch_prs_query(100);
        assert!(query.contains("$b99:String!") && query.contains("b99:pullRequests(headRefName:$b99,"));
        for field in ["isDraft", "mergeable", "mergeStateStatus", "mergeQueueEntry{id}", "commits(last:1){nodes{commit{statusCheckRollup{state}}}}", "states:[OPEN]", "states:[MERGED,CLOSED]"] {
            assert!(query.contains(field), "missing {field}");
        }
        let mut depth = 0;
        for c in query.chars() { if c == '{' { depth += 1; } else if c == '}' { depth -= 1; } assert!(depth >= 0); }
        assert_eq!(depth, 0);
    }

    #[test]
    fn parses_draft_checks_mergeability_and_queue_without_inventing_missing_data() {
        let mut pr = json!({"number":7,"title":"Status","url":"https://github.com/o/r/pull/7","state":"OPEN","isCrossRepository":false,"headRefOid":"abc","baseRefName":"main","isDraft":true,"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","mergeQueueEntry":{"id":"Q_1"},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE"}}}]}});
        let read = |pr: &Value| parse_branch_prs(&json!({"data":{"repository":{"b0":{"nodes":[pr]},"r0":{"nodes":[]}}}}).to_string(), &["feature".into()]).unwrap().remove("feature").unwrap();
        let parsed = read(&pr);
        assert!(parsed.draft && parsed.in_merge_queue);
        assert_eq!((parsed.mergeable.as_str(), parsed.merge_state_status.as_str(), parsed.checks.as_deref()), ("CONFLICTING", "DIRTY", Some("FAILURE")));
        pr["mergeQueueEntry"] = Value::Null;
        pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = Value::Null;
        let parsed = read(&pr);
        assert!(!parsed.in_merge_queue);
        assert_eq!(parsed.checks, None);
        pr["commits"]["nodes"] = json!([]);
        assert_eq!(read(&pr).checks.as_deref(), Some("UNKNOWN"));
        pr["state"] = json!("MERGED");
        let recent = json!({"data":{"repository":{"b0":{"nodes":[]},"r0":{"nodes":[pr]}}}});
        assert_eq!(parse_branch_prs(&recent.to_string(), &["feature".into()]).unwrap()["feature"].state, "MERGED");
        assert!(parse_branch_prs(r#"{"data":{"repository":{"b0":{"nodes":[]}}}}"#, &["feature".into()]).is_err());
        let partial = json!({"data":{"repository":{"b0":{"nodes":[]}}},"errors":[{"message":"rate limit"}]}).to_string();
        assert!(parse_branch_prs(&partial, &["feature".into()]).is_err());
    }

    #[test]
    fn honors_retry_after_and_primary_reset_with_no_extra_rate_limit_query() {
        let now = chrono::Utc::now();
        let limited = parse("HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\n\r\n{}", false, "secondary rate limit", now, &[]);
        assert!(limited.limited && limited.prs.is_err());
        assert_eq!(limited.retry_after, Duration::from_secs(120));
        let body = json!({"data":{"repository":{"b0":{"nodes":[]},"r0":{"nodes":[]}},"rateLimit":{"cost":1,"remaining":40,"resetAt":(now + chrono::Duration::minutes(20)).to_rfc3339()}}});
        let low = parse(&format!("HTTP/2.0 200 OK\n\n{body}"), true, "", now, &["branch".into()]);
        assert!(low.prs.unwrap().is_empty() && low.limited);
        assert_eq!(low.retry_after, Duration::from_secs(1201));
    }
}
