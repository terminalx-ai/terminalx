//! Issues from GitHub and Linear, in one shape.
//!
//! GitHub goes through the `gh` CLI, which already holds the reader's auth
//! and knows the host; the repository comes from the project's `origin`.
//! Linear is a GraphQL endpoint behind a personal API key the reader pastes
//! into settings. Both land as an [`Issue`], so the view draws one list and
//! a session started from either carries the same reference.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const LINEAR_API: &str = "https://api.linear.app/graphql";
const LIMIT: usize = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueLabel {
    pub name: String,
    /// Hex without the hash, or empty when the provider gives none.
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueAssignee {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueTeam {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// `github` or `linear`.
    pub provider: String,
    /// The provider's own id: the number for GitHub, the UUID for Linear.
    pub id: String,
    /// GitHub's stable GraphQL node id. Automation searches request it while
    /// the ordinary Issues view keeps using the issue number as `id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    /// What people call it: `#123` or `ENG-42`.
    pub identifier: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    /// The state's display name.
    pub state: String,
    /// A coarse kind across providers: `open`, `started`, `completed`, `canceled`.
    pub state_type: String,
    pub labels: Vec<IssueLabel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<IssueAssignee>,
    pub updated_at: String,
    /// Markdown; GitHub lists omit it and it is fetched on demand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<IssueTeam>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueFilter {
    pub assigned_to_me: bool,
    pub team_id: Option<String>,
    pub search: Option<String>,
}

// ------------------------------------------------------------------ GitHub

fn gh() -> Result<Command> {
    let p = crate::binpath::resolve("gh").ok_or_else(|| anyhow!("GitHub CLI (gh) is not installed or not on PATH."))?;
    let mut c = Command::new(p);
    c.env("PATH", crate::binpath::login_path());
    c.env("GH_PROMPT_DISABLED", "1");
    c.env("NO_COLOR", "1");
    Ok(c)
}

fn run_gh(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = gh()?.current_dir(cwd).args(args).output().with_context(|| format!("gh {}", args.join(" ")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!("{}", if err.is_empty() { format!("gh {} failed", args.join(" ")) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `owner/repo` from a GitHub remote URL, in either the SSH or HTTPS spelling.
pub fn github_repo_from_url(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("github.com/"))?;
    let rest = rest.trim_end_matches(".git");
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    Some(format!("{owner}/{repo}"))
}

pub fn github_repo(cwd: &Path) -> Option<String> {
    crate::git::remote_url(cwd).and_then(|u| github_repo_from_url(&u))
}

const GH_LIST_FIELDS: &str = "number,title,state,labels,assignees,updatedAt,url,author";
const GH_VIEW_FIELDS: &str = "number,title,state,labels,assignees,updatedAt,url,author,body";

pub fn parse_github_issue(v: &Value) -> Issue {
    let number = v["number"].as_i64().unwrap_or(0);
    let state = v["state"].as_str().unwrap_or("OPEN").to_string();
    let state_type = if state.eq_ignore_ascii_case("closed") { "completed" } else { "open" };
    let labels = v["labels"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    let name = l["name"].as_str()?;
                    Some(IssueLabel { name: name.into(), color: l["color"].as_str().unwrap_or("").trim_start_matches('#').into() })
                })
                .collect()
        })
        .unwrap_or_default();
    let assignee = v["assignees"].as_array().and_then(|a| a.first()).and_then(|a| {
        let login = a["login"].as_str()?;
        Some(IssueAssignee { name: a["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(login).into(), avatar_url: None })
    });
    Issue {
        provider: "github".into(),
        id: number.to_string(),
        node_id: v["id"].as_str().map(String::from),
        identifier: format!("#{number}"),
        number,
        title: v["title"].as_str().unwrap_or("").into(),
        url: v["url"].as_str().unwrap_or("").into(),
        state: {
            let mut s = state.to_ascii_lowercase();
            if let Some(f) = s.get_mut(0..1) {
                f.make_ascii_uppercase();
            }
            s
        },
        state_type: state_type.into(),
        labels,
        assignee,
        updated_at: v["updatedAt"].as_str().unwrap_or("").into(),
        body: v["body"].as_str().map(String::from),
        team: None,
    }
}

pub fn parse_github_issues(v: &Value) -> Vec<Issue> {
    v.as_array().map(|a| a.iter().map(parse_github_issue).collect()).unwrap_or_default()
}

pub fn github_list(cwd: &Path, filter: &IssueFilter) -> Result<Vec<Issue>> {
    let repo = github_repo(cwd).ok_or_else(|| anyhow!("This project has no GitHub remote. Add one named origin to see its issues."))?;
    let limit = LIMIT.to_string();
    let mut args = vec!["issue", "list", "--repo", &repo, "--state", "open", "--limit", &limit, "--json", GH_LIST_FIELDS];
    if filter.assigned_to_me {
        args.extend(["--assignee", "@me"]);
    }
    let search = filter.search.clone().unwrap_or_default();
    if !search.trim().is_empty() {
        args.extend(["--search", search.trim()]);
    }
    let out = run_gh(cwd, &args)?;
    let v: Value = serde_json::from_str(&out).context("parse gh issue list")?;
    Ok(parse_github_issues(&v))
}

pub fn github_details(cwd: &Path, number: &str) -> Result<Issue> {
    let repo = github_repo(cwd).ok_or_else(|| anyhow!("This project has no GitHub remote."))?;
    let out = run_gh(cwd, &["issue", "view", number, "--repo", &repo, "--json", GH_VIEW_FIELDS])?;
    let v: Value = serde_json::from_str(&out).context("parse gh issue view")?;
    Ok(parse_github_issue(&v))
}

const GH_AUTOMATION_FIELDS: &str = "number,id,title,body,updatedAt,labels,url,state";

/// Run an automation's raw GitHub search through the same `gh` authority and
/// error surface as the Issues view.
pub fn github_search(cwd: &Path, repo: &str, query: &str, limit: usize) -> Result<Vec<Issue>> {
    let limit = limit.min(50).to_string();
    let out = run_gh(cwd, &["issue", "list", "--repo", repo, "--search", query, "--json", GH_AUTOMATION_FIELDS, "--limit", &limit])?;
    let value: Value = serde_json::from_str(&out).context("parse gh issue list")?;
    Ok(parse_github_issues(&value))
}

pub fn github_comment(cwd: &Path, repo: &str, number: i64, body: &str) -> Result<String> {
    let output = run_gh(cwd, &["issue", "comment", &number.to_string(), "--repo", repo, "--body", body])?;
    Ok(output.trim().lines().last().unwrap_or("").to_string())
}

pub fn github_edit_labels(cwd: &Path, repo: &str, number: i64, add: &[String], remove: &[String]) -> Result<()> {
    let number = number.to_string();
    if !add.is_empty() {
        let labels = add.join(",");
        run_gh(cwd, &["issue", "edit", &number, "--repo", repo, "--add-label", &labels])?;
    }
    if !remove.is_empty() {
        let labels = remove.join(",");
        run_gh(cwd, &["issue", "edit", &number, "--repo", repo, "--remove-label", &labels])?;
    }
    Ok(())
}

// ------------------------------------------------------------------ Linear

fn graphql(key: &str, query: &str, variables: Value) -> Result<Value> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
    let resp = agent
        .post(LINEAR_API)
        .set("Authorization", key)
        .set("Content-Type", "application/json")
        .send_json(json!({"query": query, "variables": variables}));
    let body: Value = match resp {
        Ok(r) => r.into_json().context("Linear reply was not JSON")?,
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => bail!("Linear rejected the API key."),
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            bail!("Linear answered {code}: {}", text.chars().take(200).collect::<String>());
        }
        Err(e) => bail!("Could not reach Linear: {e}"),
    };
    if let Some(errs) = body.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errs.iter().filter_map(|e| e["message"].as_str()).collect::<Vec<_>>().join("; ");
        bail!("Linear: {msg}");
    }
    Ok(body["data"].clone())
}

pub fn linear_viewer(key: &str) -> Result<String> {
    let data = graphql(key, "query { viewer { id name displayName } }", json!({}))?;
    data["viewer"]["displayName"]
        .as_str()
        .or_else(|| data["viewer"]["name"].as_str())
        .map(String::from)
        .ok_or_else(|| anyhow!("Linear did not say who the key belongs to."))
}

pub fn linear_teams(key: &str) -> Result<Vec<IssueTeam>> {
    let data = graphql(key, "query { teams(first: 100) { nodes { id key name } } }", json!({}))?;
    Ok(parse_linear_teams(&data))
}

pub fn parse_linear_teams(data: &Value) -> Vec<IssueTeam> {
    data["teams"]["nodes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    Some(IssueTeam { id: t["id"].as_str()?.into(), key: t["key"].as_str().unwrap_or("").into(), name: t["name"].as_str().unwrap_or("").into() })
                })
                .collect()
        })
        .unwrap_or_default()
}

const ISSUE_FIELDS: &str = "id identifier number title description url updatedAt priority state { name type color } labels { nodes { name color } } assignee { name displayName avatarUrl } team { id key name }";

fn parse_linear_issue(n: &Value) -> Option<Issue> {
    let id = n["id"].as_str()?;
    let labels = n["labels"]["nodes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| Some(IssueLabel { name: l["name"].as_str()?.into(), color: l["color"].as_str().unwrap_or("").trim_start_matches('#').into() }))
                .collect()
        })
        .unwrap_or_default();
    let assignee = n["assignee"].as_object().map(|a| IssueAssignee {
        name: a.get("displayName").and_then(|d| d.as_str()).or_else(|| a.get("name").and_then(|d| d.as_str())).unwrap_or("").into(),
        avatar_url: a.get("avatarUrl").and_then(|u| u.as_str()).map(String::from),
    });
    let team = n["team"].as_object().map(|t| IssueTeam {
        id: t.get("id").and_then(|v| v.as_str()).unwrap_or("").into(),
        key: t.get("key").and_then(|v| v.as_str()).unwrap_or("").into(),
        name: t.get("name").and_then(|v| v.as_str()).unwrap_or("").into(),
    });
    Some(Issue {
        provider: "linear".into(),
        id: id.into(),
        node_id: None,
        identifier: n["identifier"].as_str().unwrap_or("").into(),
        number: n["number"].as_i64().unwrap_or(0),
        title: n["title"].as_str().unwrap_or("").into(),
        url: n["url"].as_str().unwrap_or("").into(),
        state: n["state"]["name"].as_str().unwrap_or("").into(),
        state_type: match n["state"]["type"].as_str().unwrap_or("") {
            "completed" => "completed",
            "canceled" | "cancelled" => "canceled",
            "started" => "started",
            _ => "open",
        }
        .into(),
        labels,
        assignee,
        updated_at: n["updatedAt"].as_str().unwrap_or("").into(),
        body: n["description"].as_str().map(String::from),
        team,
    })
}

pub fn parse_linear_issues(data: &Value) -> Vec<Issue> {
    data["issues"]["nodes"].as_array().map(|a| a.iter().filter_map(parse_linear_issue).collect()).unwrap_or_default()
}

pub fn linear_list(key: &str, filter: &IssueFilter) -> Result<Vec<Issue>> {
    let mut f = json!({"state": {"type": {"nin": ["completed", "canceled"]}}});
    if filter.assigned_to_me {
        f["assignee"] = json!({"isMe": {"eq": true}});
    }
    if let Some(team) = filter.team_id.as_deref().filter(|t| !t.is_empty()) {
        f["team"] = json!({"id": {"eq": team}});
    }
    let query = format!("query($first: Int!, $filter: IssueFilter) {{ issues(first: $first, filter: $filter, orderBy: updatedAt) {{ nodes {{ {ISSUE_FIELDS} }} }} }}");
    let data = graphql(key, &query, json!({"first": LIMIT, "filter": f}))?;
    let mut issues = parse_linear_issues(&data);
    // Linear has no cheap free-text filter on this query; the list is small, so it is done here.
    if let Some(q) = filter.search.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let q = q.to_lowercase();
        issues.retain(|i| i.title.to_lowercase().contains(&q) || i.identifier.to_lowercase().contains(&q));
    }
    Ok(issues)
}

pub fn linear_details(key: &str, id: &str) -> Result<Issue> {
    let query = format!("query($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} comments(first: 20) {{ nodes {{ body createdAt user {{ displayName name }} }} }} }} }}");
    let data = graphql(key, &query, json!({"id": id}))?;
    let mut issue = parse_linear_issue(&data["issue"]).ok_or_else(|| anyhow!("Linear did not return that issue."))?;
    // Comments ride along under the description so the agent sees the discussion too.
    if let Some(comments) = data["issue"]["comments"]["nodes"].as_array().filter(|c| !c.is_empty()) {
        let mut body = issue.body.clone().unwrap_or_default();
        body.push_str("\n\n---\n\n## Comments\n");
        for c in comments {
            let who = c["user"]["displayName"].as_str().or_else(|| c["user"]["name"].as_str()).unwrap_or("someone");
            body.push_str(&format!("\n**{who}**: {}\n", c["body"].as_str().unwrap_or("")));
        }
        issue.body = Some(body);
    }
    Ok(issue)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_from_remote_urls() {
        assert_eq!(github_repo_from_url("git@github.com:acme/widgets.git").as_deref(), Some("acme/widgets"));
        assert_eq!(github_repo_from_url("https://github.com/acme/widgets").as_deref(), Some("acme/widgets"));
        assert_eq!(github_repo_from_url("https://github.com/acme/widgets.git/").as_deref(), Some("acme/widgets"));
        assert_eq!(github_repo_from_url("ssh://git@github.com/acme/widgets.git").as_deref(), Some("acme/widgets"));
        assert_eq!(github_repo_from_url("https://gitlab.com/acme/widgets"), None);
    }

    #[test]
    fn github_list_parses() {
        let v: Value = serde_json::from_str(r#"[{"number":7,"title":"Login times out","state":"OPEN","labels":[{"name":"bug","color":"d73a4a"}],"assignees":[{"login":"sam","name":"Sam"}],"updatedAt":"2026-09-01T10:00:00Z","url":"https://github.com/acme/widgets/issues/7","author":{"login":"kim"}},{"number":8,"title":"Done thing","state":"CLOSED","labels":[],"assignees":[],"updatedAt":"2026-08-01T10:00:00Z","url":"u","author":{"login":"kim"}}]"#).unwrap();
        let issues = parse_github_issues(&v);
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].identifier, "#7");
        assert_eq!(issues[0].provider, "github");
        assert_eq!(issues[0].state, "Open");
        assert_eq!(issues[0].state_type, "open");
        assert_eq!(issues[0].labels[0].color, "d73a4a");
        assert_eq!(issues[0].assignee.as_ref().unwrap().name, "Sam");
        assert!(issues[0].body.is_none());
        assert_eq!(issues[1].state_type, "completed");
    }

    #[test]
    fn linear_list_parses() {
        let v: Value = serde_json::from_str(r##"{"issues":{"nodes":[{"id":"uuid-1","identifier":"ENG-42","number":42,"title":"Fix login timeout","description":"Users get logged out.","url":"https://linear.app/acme/issue/ENG-42","updatedAt":"2026-09-01T10:00:00Z","priority":2,"state":{"name":"In Progress","type":"started","color":"#f2c94c"},"labels":{"nodes":[{"name":"Bug","color":"#eb5757"}]},"assignee":{"name":"sam","displayName":"Sam","avatarUrl":"https://a/b.png"},"team":{"id":"t1","key":"ENG","name":"Engineering"}}]}}"##).unwrap();
        let issues = parse_linear_issues(&v);
        assert_eq!(issues.len(), 1);
        let i = &issues[0];
        assert_eq!(i.provider, "linear");
        assert_eq!(i.identifier, "ENG-42");
        assert_eq!(i.state_type, "started");
        assert_eq!(i.labels[0].color, "eb5757");
        assert_eq!(i.assignee.as_ref().unwrap().name, "Sam");
        assert_eq!(i.team.as_ref().unwrap().key, "ENG");
        assert_eq!(i.body.as_deref(), Some("Users get logged out."));
        let teams = parse_linear_teams(&serde_json::from_str::<Value>(r#"{"teams":{"nodes":[{"id":"t1","key":"ENG","name":"Engineering"}]}}"#).unwrap());
        assert_eq!(teams[0].key, "ENG");
    }
}
