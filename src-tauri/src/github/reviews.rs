//! Review threads are addressed by the PR URL, never by a checkout's current remote.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub author: Option<Author>,
    pub body: String,
    pub url: String,
    pub created_at: String,
    pub diff_hunk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Author {
    pub login: String,
    /// A person's display name, shown on inline threads (PRO-234). Bots and
    /// people without one have none; the login stands in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DiffSide { Left, Right }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    pub start_line: Option<u32>,
    pub original_start_line: Option<u32>,
    pub diff_side: DiffSide,
    pub start_diff_side: Option<DiffSide>,
    pub is_outdated: bool,
    pub is_resolved: bool,
    pub viewer_can_resolve: bool,
    pub viewer_can_unresolve: bool,
    pub viewer_can_reply: bool,
    #[serde(skip_deserializing)]
    pub comments: Vec<ReviewComment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreads {
    pub url: String,
    pub head_oid: String,
    pub base_oid: String,
    pub threads: Vec<ReviewThread>,
}

/// A GitHub PR patch, read only while the PR still matches the thread snapshot.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    pub old_path: Option<String>,
    pub head_oid: String,
    pub base_oid: String,
    /// GitHub omits patches for binary/oversized files. Never invent coordinates.
    pub patch: Option<String>,
}

const COMMENTS: &str = "nodes { id author { login ... on User { name } } body url createdAt diffHunk } pageInfo { hasNextPage endCursor }";
const THREAD: &str = "id path line originalLine startLine originalStartLine diffSide startDiffSide isOutdated isResolved viewerCanResolve viewerCanUnresolve viewerCanReply";
const THREAD_OWNER: &str = "query($id:ID!) { node(id:$id) { ... on PullRequestReviewThread { id pullRequest { url } } } }";
const RESOLVE: &str = "mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }";
const UNRESOLVE: &str = "mutation($id:ID!) { unresolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }";
const REPLY: &str = "mutation($id:ID!,$body:String!) { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}) { comment { id } } }";

struct Target { url: String, host: String, owner: String, name: String, number: String }
impl Target {
    fn new(url: &str) -> Result<Self> {
        let identity = crate::pr_associations::identity(url)?;
        let url = url::Url::parse(&identity)?;
        if url.port().is_some() { bail!("GitHub host must not include a port"); }
        let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
        if parts[..2].iter().any(|part| !part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))) {
            bail!("Invalid GitHub repository name");
        }
        Ok(Self { url: identity.clone(), host: url.host_str().context("Missing GitHub host")?.into(), owner: parts[0].into(), name: parts[1].into(), number: parts[3].into() })
    }

    fn query(&self, query: &str, fields: &[(&str, &str)], run: &mut impl FnMut(&[&str]) -> Result<String>) -> Result<Value> {
        let mut owned = vec![format!("query={query}")];
        owned.extend(fields.iter().map(|(key, value)| format!("{key}={value}")));
        let mut args = vec!["api", "graphql", "--hostname", &self.host];
        // Raw fields are essential: a reply starting with @ must never read a local file.
        args.extend(owned.iter().flat_map(|field| ["-f", field.as_str()]));
        let value: Value = serde_json::from_str(&run(&args)?)?;
        if let Some(errors) = value["errors"].as_array().filter(|errors| !errors.is_empty()) {
            bail!("GitHub: {}", errors.iter().map(|e| e["message"].as_str().unwrap_or("GraphQL request failed")).collect::<Vec<_>>().join("; "));
        }
        if !value["data"].is_object() { bail!("GitHub did not return review data"); }
        Ok(value["data"].clone())
    }
}

fn run(args: &[&str]) -> Result<String> {
    super::run_bounded(&super::outside_checkouts(), args)
}

fn nodes(connection: &Value) -> Result<&Vec<Value>> {
    connection["nodes"].as_array().context("GitHub did not return a complete review connection")
}

fn next_cursor(connection: &Value, seen: &mut HashSet<String>) -> Result<Option<String>> {
    match connection["pageInfo"]["hasNextPage"].as_bool() {
        Some(false) => Ok(None),
        Some(true) => {
            let cursor = connection["pageInfo"]["endCursor"].as_str().filter(|s| !s.is_empty()).context("GitHub omitted a review page cursor")?;
            if !seen.insert(cursor.into()) || seen.len() > 100 { bail!("GitHub review pagination did not finish"); }
            Ok(Some(cursor.into()))
        }
        None => bail!("GitHub omitted review pagination information"),
    }
}

pub fn list(url: &str) -> Result<ReviewThreads> {
    let _request = crate::github_process::scope();
    list_with(url, &mut run)
}

fn list_with(url: &str, run: &mut impl FnMut(&[&str]) -> Result<String>) -> Result<ReviewThreads> {
    let target = Target::new(url)?;
    // The PR number is validated digits; all other values travel as variables.
    let query = format!("query($owner:String!,$name:String!,$cursor:String) {{ repository(owner:$owner,name:$name) {{ pullRequest(number:{}) {{ url headRefOid baseRefOid reviewThreads(first:100,after:$cursor) {{ nodes {{ {THREAD} comments(first:100) {{ {COMMENTS} }} }} pageInfo {{ hasNextPage endCursor }} }} }} }} }}", target.number);
    let comments_query = format!("query($id:ID!,$cursor:String!) {{ node(id:$id) {{ ... on PullRequestReviewThread {{ comments(first:100,after:$cursor) {{ {COMMENTS} }} }} }} }}");
    let mut result: Option<ReviewThreads> = None;
    let mut seen = HashSet::new();
    let mut cursor = None::<String>;
    loop {
        let mut fields = vec![("owner", target.owner.as_str()), ("name", target.name.as_str())];
        if let Some(cursor) = &cursor { fields.push(("cursor", cursor)); }
        let data = target.query(&query, &fields, run)?;
        let pr = &data["repository"]["pullRequest"];
        let head = pr["headRefOid"].as_str().context("GitHub did not return the PR head")?;
        let base = pr["baseRefOid"].as_str().context("GitHub did not return the PR base")?;
        let returned_url = pr["url"].as_str().context("GitHub did not return the PR URL")?;
        if crate::pr_associations::identity(returned_url)? != target.url { bail!("GitHub returned a different pull request"); }
        let result = result.get_or_insert_with(|| ReviewThreads { url: target.url.clone(), head_oid: head.into(), base_oid: base.into(), threads: Vec::new() });
        if result.head_oid != head || result.base_oid != base { bail!("The pull request changed while reading reviews. Refresh to try again."); }
        let connection = &pr["reviewThreads"];
        for node in nodes(connection)? {
            let mut thread: ReviewThread = serde_json::from_value(node.clone())?;
            let mut comments = node["comments"].clone();
            let mut seen_comments = HashSet::new();
            loop {
                for comment in nodes(&comments)? { thread.comments.push(serde_json::from_value(comment.clone())?); }
                let Some(cursor) = next_cursor(&comments, &mut seen_comments)? else { break; };
                let data = target.query(&comments_query, &[("id", &thread.id), ("cursor", &cursor)], run)?;
                comments = data["node"]["comments"].clone();
            }
            result.threads.push(thread);
        }
        cursor = next_cursor(connection, &mut seen)?;
        if cursor.is_none() { break; }
    }
    result.context("GitHub did not return review threads")
}

pub fn files(url: &str, head: &str, base: &str) -> Result<Vec<ReviewFile>> {
    let _request = crate::github_process::scope();
    files_with(url, head, base, &mut run)
}

fn files_with(url: &str, head: &str, base: &str, run: &mut impl FnMut(&[&str]) -> Result<String>) -> Result<Vec<ReviewFile>> {
    let target = Target::new(url)?;
    if head.is_empty() || base.is_empty() { bail!("PR revisions are required"); }
    let check = |run: &mut dyn FnMut(&[&str]) -> Result<String>| -> Result<()> {
        let pr: Value = serde_json::from_str(&run(&["pr", "view", &target.url, "--json", "url,headRefOid,baseRefOid"])?)?;
        if pr["headRefOid"].as_str() != Some(head) || pr["baseRefOid"].as_str() != Some(base)
            || crate::pr_associations::identity(pr["url"].as_str().context("Missing PR identity")?)? != target.url {
            bail!("The pull request changed. Refresh threads to load its latest diff.");
        }
        Ok(())
    };
    check(run)?;
    let endpoint = format!("repos/{}/{}/pulls/{}/files?per_page=100", target.owner, target.name, target.number);
    let pages: Value = serde_json::from_str(&run(&["api", "--hostname", &target.host, &endpoint, "--paginate", "--slurp"])?)?;
    let mut files = Vec::new();
    for page in pages.as_array().context("GitHub did not return PR file pages")? {
        for entry in page.as_array().context("GitHub did not return PR files")? {
            files.push(ReviewFile {
                path: entry["filename"].as_str().context("GitHub omitted a PR file path")?.into(),
                old_path: entry["previous_filename"].as_str().map(String::from),
                head_oid: head.into(), base_oid: base.into(),
                patch: entry["patch"].as_str().map(String::from),
            });
        }
    }
    // A push during pagination would mix revisions. Never cache an unverified list.
    check(run)?;
    Ok(files)
}

fn check_thread(target: &Target, id: &str, run: &mut impl FnMut(&[&str]) -> Result<String>) -> Result<()> {
    if id.is_empty() || id.len() > 512 { bail!("A review thread ID is required"); }
    let data = target.query(THREAD_OWNER, &[("id", id)], run)?;
    let url = data["node"]["pullRequest"]["url"].as_str().context("GitHub did not return this review thread")?;
    if data["node"]["id"].as_str() != Some(id) || crate::pr_associations::identity(url)? != target.url { bail!("Review thread belongs to a different pull request"); }
    Ok(())
}

pub fn resolve(url: &str, id: &str, resolved: bool) -> Result<()> {
    let _request = crate::github_process::scope();
    resolve_with(url, id, resolved, &mut run)
}

fn resolve_with(url: &str, id: &str, resolved: bool, run: &mut impl FnMut(&[&str]) -> Result<String>) -> Result<()> {
    let target = Target::new(url)?;
    check_thread(&target, id, run)?;
    let (query, field) = if resolved { (RESOLVE, "resolveReviewThread") } else { (UNRESOLVE, "unresolveReviewThread") };
    let data = target.query(query, &[("id", id)], run)?;
    if data[field]["thread"]["id"].as_str() != Some(id) || data[field]["thread"]["isResolved"].as_bool() != Some(resolved) {
        bail!("GitHub did not confirm the thread's resolved state. Refresh before retrying.");
    }
    Ok(())
}

pub fn reply(url: &str, id: &str, body: &str) -> Result<()> {
    let _request = crate::github_process::scope();
    reply_with(url, id, body, &mut run)
}

fn reply_with(url: &str, id: &str, body: &str, run: &mut impl FnMut(&[&str]) -> Result<String>) -> Result<()> {
    if body.trim().is_empty() || body.len() > 65536 { bail!("A reply must contain between 1 and 65536 bytes of text"); }
    let target = Target::new(url)?;
    check_thread(&target, id, run)?;
    // Never retry a reply automatically: a lost response can still mean it was posted.
    let data = target.query(REPLY, &[("id", id), ("body", body)], run)?;
    if data["addPullRequestReviewThreadReply"]["comment"]["id"].as_str().filter(|s| !s.is_empty()).is_none() {
        bail!("GitHub did not confirm the reply. Refresh before retrying.");
    }
    Ok(())
}

#[cfg(test)]
mod tests;
