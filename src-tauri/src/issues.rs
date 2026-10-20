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
    /// What `issue_set_labels` takes: the label's id on Linear, its name on
    /// GitHub. Lists leave it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
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

/// A person as an issue shows them: an assignee, an author, a team member.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueUser {
    /// What `issue_set_assignees` takes: the user's id on Linear, the login on GitHub.
    pub id: String,
    pub name: String,
    /// The GitHub login; Linear has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
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
    /// Linear's own type for the workflow state (`triage`, `backlog`,
    /// `unstarted`, `started`, `completed`, `canceled`), which `state_type`
    /// folds together; GitHub has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_state_type: Option<String>,
    pub labels: Vec<IssueLabel>,
    /// The first of `assignees`, for what reads one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<IssueAssignee>,
    /// Every assignee, so a list row can show who has the issue.
    #[serde(default)]
    pub assignees: Vec<IssueUser>,
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
    /// The older spelling of `assignee: me`.
    pub assigned_to_me: bool,
    pub team_id: Option<String>,
    pub search: Option<String>,
    /// `open` (the default) or `all`; `closed` on GitHub; on Linear also a
    /// workflow state type (`triage`, `backlog`, `unstarted`, `started`,
    /// `completed`, `canceled`). "Open" on Linear is neither completed nor canceled.
    pub state: Option<String>,
    pub assignee: Option<AssigneeFilter>,
    /// Label names. GitHub lists issues with all of them and Linear issues
    /// with any of them, as each website's own label filter does.
    pub labels: Vec<String>,
    /// `updated` (recently updated, the default), `created` (newest),
    /// `created_asc` (oldest), or `priority` (Linear: urgent first, none last).
    pub sort: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AssigneeFilter {
    Me,
    Unassigned,
    /// Someone as assignees are named: the GitHub login, the Linear user id.
    Person { id: String },
}

impl IssueFilter {
    fn assignee(&self) -> Option<AssigneeFilter> {
        self.assignee.clone().or(self.assigned_to_me.then_some(AssigneeFilter::Me))
    }

    fn state(&self) -> &str {
        self.state.as_deref().map(str::trim).filter(|state| !state.is_empty()).unwrap_or("open")
    }

    fn sort(&self) -> &str {
        self.sort.as_deref().map(str::trim).filter(|sort| !sort.is_empty()).unwrap_or("updated")
    }

    fn search(&self) -> Option<&str> {
        self.search.as_deref().map(str::trim).filter(|search| !search.is_empty())
    }
}

// ------------------------------------------------------------------ GitHub

pub(crate) fn gh() -> Result<Command> {
    let p = crate::binpath::resolve("gh").ok_or_else(|| anyhow!("GitHub CLI (gh) is not installed or not on PATH."))?;
    let mut c = Command::new(p);
    c.env("PATH", crate::binpath::login_path());
    c.env("GH_PROMPT_DISABLED", "1");
    c.env("NO_COLOR", "1");
    Ok(c)
}

fn run_gh(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = gh()?.current_dir(gh_dir(cwd)).args(args).output().with_context(|| format!("gh {}", args.join(" ")))?;
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

/// An issue as someone names it on a command line: `#433` or `433` for
/// GitHub, `ENG-42` for Linear, or either tracker's URL for the issue. The
/// answer is the provider and what its details call takes.
pub fn parse_issue_reference(reference: &str, provider: Option<&str>) -> std::result::Result<(&'static str, String), String> {
    let reference = reference.trim();
    let is_number = |text: &str| !text.is_empty() && text.chars().all(|ch| ch.is_ascii_digit());
    let is_key = |text: &str| {
        text.split_once('-').is_some_and(|(team, number)| team.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) && team.chars().all(|ch| ch.is_ascii_alphanumeric()) && is_number(number))
    };
    let after = |marker: &str| reference.split_once(marker).map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or("").to_string());
    let found = if reference.contains("github.com/") {
        after("/issues/").filter(|number| is_number(number)).map(|number| ("github", number))
    } else if reference.contains("linear.app/") {
        after("/issue/").filter(|key| is_key(key)).map(|key| ("linear", key.to_ascii_uppercase()))
    } else if is_number(reference.trim_start_matches('#')) {
        Some(("github", reference.trim_start_matches('#').to_string()))
    } else if is_key(reference) {
        Some(("linear", reference.to_ascii_uppercase()))
    } else {
        None
    };
    let (found_provider, id) = found.ok_or_else(|| format!("{reference:?} is not an issue. Use #123 or a GitHub issue URL, or ENG-42 or a Linear issue URL."))?;
    match provider {
        Some(asked) if asked != found_provider => Err(format!("{reference} is a {} issue, not a {asked} one.", if found_provider == "github" { "GitHub" } else { "Linear" })),
        _ => Ok((found_provider, id)),
    }
}

/// The `owner/repo` a GitHub issue URL points into; `None` for anything else.
pub fn github_issue_url_repo(reference: &str) -> Option<String> {
    let (_, rest) = reference.trim().split_once("github.com/")?;
    let mut parts = rest.split('/');
    let (owner, repo, kind) = (parts.next()?, parts.next()?, parts.next()?);
    (kind == "issues" && !owner.is_empty() && !repo.is_empty()).then(|| format!("{owner}/{repo}"))
}

pub fn github_repo(cwd: &Path) -> Option<String> {
    if let Some(repo) = cloud_project_repo(cwd) {
        return Some(repo);
    }
    crate::git::remote_url(cwd).and_then(|u| github_repo_from_url(&u))
}

/// The repository (`owner/name`) of a cloud project, as the window names one:
/// `cloud:<orgId>:github.com/<owner>/<name>`. A cloud project has no checkout
/// on this computer, so its issues are its repository's, read and written
/// with the reader's own `gh`. `None` for anything else, a blank cloud
/// project (no repository) included.
pub fn cloud_project_repo(project: &Path) -> Option<String> {
    let (_, identity) = project.to_str()?.strip_prefix("cloud:")?.rsplit_once(':')?;
    let mut parts = identity.strip_prefix("github.com/")?.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    let valid = |part: &str| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')) && part != "." && part != "..";
    (parts.next().is_none() && valid(owner) && valid(name)).then(|| format!("{owner}/{name}"))
}

/// Where `gh` runs for a project: in its checkout, which tells `gh` the
/// host; for a cloud project, outside any checkout, with the repository
/// named in the call.
pub fn gh_dir(project: &Path) -> std::path::PathBuf {
    if cloud_project_repo(project).is_some() {
        std::env::temp_dir()
    } else {
        project.to_path_buf()
    }
}

const GH_LIST_FIELDS: &str = "number,title,state,stateReason,labels,assignees,updatedAt,url,author";
const GH_VIEW_FIELDS: &str = "number,title,state,labels,assignees,updatedAt,url,author,body";

pub fn parse_github_issue(v: &Value) -> Issue {
    let number = v["number"].as_i64().unwrap_or(0);
    let state = v["state"].as_str().unwrap_or("OPEN").to_string();
    // As the issue's own page reads it: closed as not planned is canceled.
    let state_type = match (state.eq_ignore_ascii_case("closed"), v["stateReason"].as_str()) {
        (true, Some(reason)) if reason.eq_ignore_ascii_case("not_planned") => "canceled",
        (true, _) => "completed",
        _ => "open",
    };
    let labels = v["labels"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    let name = l["name"].as_str()?;
                    Some(IssueLabel { id: None, name: name.into(), color: l["color"].as_str().unwrap_or("").trim_start_matches('#').into() })
                })
                .collect()
        })
        .unwrap_or_default();
    // `gh issue list` gives no avatar; GitHub serves one at the login's own address.
    let assignees: Vec<IssueUser> = v["assignees"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|a| {
                    let login = a["login"].as_str()?;
                    Some(IssueUser {
                        id: login.into(),
                        name: a["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(login).into(),
                        login: Some(login.into()),
                        avatar_url: Some(format!("https://github.com/{login}.png?size=64")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let assignee = assignees.first().map(|first| IssueAssignee { name: first.name.clone(), avatar_url: None });
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
        workflow_state_type: None,
        labels,
        assignee,
        assignees,
        updated_at: v["updatedAt"].as_str().unwrap_or("").into(),
        body: v["body"].as_str().map(String::from),
        team: None,
    }
}

pub fn parse_github_issues(v: &Value) -> Vec<Issue> {
    v.as_array().map(|a| a.iter().map(parse_github_issue).collect()).unwrap_or_default()
}

/// How a GitHub list is read for a filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GithubList {
    /// `GET /repos/{repo}/issues` with these parameters: the repository's own
    /// list, which shows an issue's new state the moment it changes.
    Rest(Vec<(&'static str, String)>),
    /// `gh issue list` with these arguments, for free text: only GitHub's
    /// search finds words, and its index lags a change by a few seconds.
    Search(Vec<String>),
}

/// How `filter` is read, as the website's list shows it: labels all
/// present, the sort and direction it names. `me` is the reader's login,
/// asked for only when the list is the reader's.
pub fn github_list_query(repo: &str, filter: &IssueFilter, me: impl FnOnce() -> Result<String>) -> Result<GithubList> {
    let state = match filter.state() {
        state @ ("open" | "closed" | "all") => state,
        other => bail!("GitHub issues are open or closed, not {other}."),
    };
    let (sort, direction) = match filter.sort() {
        "updated" => ("updated", "desc"),
        "created" => ("created", "desc"),
        "created_asc" => ("created", "asc"),
        "priority" => bail!("GitHub issues have no priority to sort by."),
        other => bail!("Unknown sort {other}."),
    };
    let labels: Vec<&str> = filter.labels.iter().map(|label| label.trim()).filter(|label| !label.is_empty()).collect();
    let assignee = filter.assignee();
    let Some(text) = filter.search() else {
        let mut params = vec![("state", state.to_string()), ("sort", sort.to_string()), ("direction", direction.to_string())];
        match assignee {
            Some(AssigneeFilter::Me) => params.push(("assignee", me()?)),
            Some(AssigneeFilter::Unassigned) => params.push(("assignee", "none".into())),
            Some(AssigneeFilter::Person { id }) => params.push(("assignee", id)),
            None => {}
        }
        if !labels.is_empty() {
            params.push(("labels", labels.join(",")));
        }
        return Ok(GithubList::Rest(params));
    };
    let mut args: Vec<String> = ["issue", "list", "--repo", repo, "--state", state, "--limit", &LIMIT.to_string(), "--json", GH_LIST_FIELDS].map(String::from).into();
    let mut search = Vec::new();
    match assignee {
        Some(AssigneeFilter::Me) => args.extend(["--assignee".into(), "@me".into()]),
        Some(AssigneeFilter::Unassigned) => search.push("no:assignee".to_string()),
        Some(AssigneeFilter::Person { id }) => args.extend(["--assignee".into(), id]),
        None => {}
    }
    for label in labels {
        args.extend(["--label".into(), label.into()]);
    }
    search.push(text.to_string());
    search.push(format!("sort:{sort}-{direction}"));
    args.extend(["--search".into(), search.join(" ")]);
    Ok(GithubList::Search(args))
}

/// A row of `GET /repos/{repo}/issues`, or `None` for a pull request, which that list also holds.
pub fn parse_github_rest_issue(v: &Value) -> Option<Issue> {
    if !v["pull_request"].is_null() {
        return None;
    }
    let number = v["number"].as_i64()?;
    let closed = v["state"].as_str() == Some("closed");
    let labels = v["labels"]
        .as_array()
        .map(|all| all.iter().filter_map(|l| Some(IssueLabel { id: None, name: l["name"].as_str()?.into(), color: l["color"].as_str().unwrap_or("").trim_start_matches('#').into() })).collect())
        .unwrap_or_default();
    // This list names people by login only.
    let assignees: Vec<IssueUser> = v["assignees"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter_map(|a| {
                    let login = a["login"].as_str()?;
                    Some(IssueUser { id: login.into(), name: login.into(), login: Some(login.into()), avatar_url: a["avatar_url"].as_str().map(String::from) })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Issue {
        provider: "github".into(),
        id: number.to_string(),
        node_id: v["node_id"].as_str().map(String::from),
        identifier: format!("#{number}"),
        number,
        title: v["title"].as_str().unwrap_or("").into(),
        url: v["html_url"].as_str().unwrap_or("").into(),
        state: if closed { "Closed" } else { "Open" }.into(),
        state_type: match (closed, v["state_reason"].as_str()) {
            (true, Some("not_planned")) => "canceled",
            (true, _) => "completed",
            _ => "open",
        }
        .into(),
        workflow_state_type: None,
        labels,
        assignee: assignees.first().map(|first| IssueAssignee { name: first.name.clone(), avatar_url: first.avatar_url.clone() }),
        assignees,
        updated_at: v["updated_at"].as_str().unwrap_or("").into(),
        body: None,
        team: None,
    })
}

/// The most pages of 100 read to fill a list that pull requests share.
const REST_PAGES: usize = 3;

pub fn github_list(cwd: &Path, filter: &IssueFilter) -> Result<Vec<Issue>> {
    let repo = github_repo(cwd).ok_or_else(|| anyhow!("This project has no GitHub remote. Add one named origin to see its issues."))?;
    let me = || Ok(run_gh(cwd, &["api", "user", "--jq", ".login"])?.trim().to_string());
    match github_list_query(&repo, filter, me)? {
        GithubList::Search(args) => {
            let out = run_gh(cwd, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
            let v: Value = serde_json::from_str(&out).context("parse gh issue list")?;
            Ok(parse_github_issues(&v))
        }
        GithubList::Rest(params) => {
            let path = format!("repos/{repo}/issues");
            let mut issues = Vec::new();
            for page in 1..=REST_PAGES {
                let mut args = vec!["api".to_string(), "-X".into(), "GET".into(), path.clone(), "-f".into(), "per_page=100".into(), "-f".into(), format!("page={page}")];
                for (name, value) in &params {
                    args.extend(["-f".into(), format!("{name}={value}")]);
                }
                let out = run_gh(cwd, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
                let v: Value = serde_json::from_str(&out).context("parse the issue list")?;
                let rows = v.as_array().map(Vec::as_slice).unwrap_or_default();
                issues.extend(rows.iter().filter_map(parse_github_rest_issue));
                if rows.len() < 100 || issues.len() >= LIMIT {
                    break;
                }
            }
            issues.truncate(LIMIT);
            Ok(issues)
        }
    }
}

pub fn github_details(cwd: &Path, number: &str) -> Result<Issue> {
    let repo = github_repo(cwd).ok_or_else(|| anyhow!("This project has no GitHub remote."))?;
    let out = run_gh(cwd, &["issue", "view", number, "--repo", &repo, "--json", GH_VIEW_FIELDS])?;
    let v: Value = serde_json::from_str(&out).context("parse gh issue view")?;
    Ok(parse_github_issue(&v))
}

/// An issue in a repository named by `owner/name`, with no checkout of it
/// here: a cloud workspace's (#441).
pub fn github_details_in(repo: &str, number: &str) -> Result<Issue> {
    let out = run_gh(&std::env::temp_dir(), &["issue", "view", number, "--repo", repo, "--json", GH_VIEW_FIELDS])?;
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

/// The id of the person the key belongs to, as an assignee is named.
pub fn linear_viewer_id(key: &str) -> Result<String> {
    let data = graphql(key, "query { viewer { id } }", json!({}))?;
    data["viewer"]["id"].as_str().map(String::from).ok_or_else(|| anyhow!("Linear did not say who the key belongs to."))
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

const ISSUE_FIELDS: &str = "id identifier number title description url updatedAt priority state { name type color } labels { nodes { name color } } assignee { id name displayName avatarUrl } team { id key name }";

pub(crate) fn parse_linear_issue(n: &Value) -> Option<Issue> {
    let id = n["id"].as_str()?;
    let labels = n["labels"]["nodes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| Some(IssueLabel { id: l["id"].as_str().map(String::from), name: l["name"].as_str()?.into(), color: l["color"].as_str().unwrap_or("").trim_start_matches('#').into() }))
                .collect()
        })
        .unwrap_or_default();
    let assignee = n["assignee"].as_object().map(|a| IssueAssignee {
        name: a.get("displayName").and_then(|d| d.as_str()).or_else(|| a.get("name").and_then(|d| d.as_str())).unwrap_or("").into(),
        avatar_url: a.get("avatarUrl").and_then(|u| u.as_str()).map(String::from),
    });
    // Linear has one assignee or none.
    let assignees = match (n["assignee"]["id"].as_str(), &assignee) {
        (Some(user), Some(a)) => vec![IssueUser { id: user.into(), name: a.name.clone(), login: None, avatar_url: a.avatar_url.clone() }],
        _ => Vec::new(),
    };
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
        workflow_state_type: n["state"]["type"].as_str().filter(|kind| !kind.is_empty()).map(String::from),
        labels,
        assignee,
        assignees,
        updated_at: n["updatedAt"].as_str().unwrap_or("").into(),
        body: n["description"].as_str().map(String::from),
        team,
    })
}

pub fn parse_linear_issues(data: &Value) -> Vec<Issue> {
    data["issues"]["nodes"].as_array().map(|a| a.iter().filter_map(parse_linear_issue).collect()).unwrap_or_default()
}

/// Linear's workflow state types, which its list filters by.
const LINEAR_STATE_TYPES: [&str; 6] = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

/// The `filter` and `sort` Linear's `issues` query takes for `filter`.
pub fn linear_list_variables(filter: &IssueFilter) -> Result<Value> {
    let mut f = json!({});
    match filter.state() {
        "open" => f["state"] = json!({"type": {"nin": ["completed", "canceled"]}}),
        "all" => {}
        kind if LINEAR_STATE_TYPES.contains(&kind) => f["state"] = json!({"type": {"eq": kind}}),
        other => bail!("Linear has no {other} state type."),
    }
    match filter.assignee() {
        Some(AssigneeFilter::Me) => f["assignee"] = json!({"isMe": {"eq": true}}),
        Some(AssigneeFilter::Unassigned) => f["assignee"] = json!({"null": true}),
        Some(AssigneeFilter::Person { id }) => f["assignee"] = json!({"id": {"eq": id}}),
        None => {}
    }
    if let Some(team) = filter.team_id.as_deref().filter(|t| !t.is_empty()) {
        f["team"] = json!({"id": {"eq": team}});
    }
    let labels: Vec<&str> = filter.labels.iter().map(|label| label.trim()).filter(|label| !label.is_empty()).collect();
    if !labels.is_empty() {
        f["labels"] = json!({"some": {"name": {"in": labels}}});
    }
    // The title, or the issue's own number (`42`, `ENG-42`), found on Linear's side rather than in the first page.
    if let Some(q) = filter.search() {
        let mut any = vec![json!({"title": {"containsIgnoreCase": q}})];
        let (team, number) = q.rsplit_once('-').map_or(("", q), |(team, number)| (team, number));
        if let Ok(number) = number.parse::<i64>() {
            // Spelled with `and`: Linear reads a branch of `or` with two fields in it as matching everything.
            let by_number = json!({"number": {"eq": number}});
            any.push(if team.is_empty() { by_number } else { json!({"and": [by_number, {"team": {"key": {"eqIgnoreCase": team}}}]}) });
        }
        f["or"] = Value::Array(any);
    }
    let newest_updated = json!({"updatedAt": {"order": "Descending"}});
    let sort = match filter.sort() {
        "updated" => json!([newest_updated]),
        "created" => json!([{"createdAt": {"order": "Descending"}}]),
        "created_asc" => json!([{"createdAt": {"order": "Ascending"}}]),
        // Linear's descending priority is its own order: urgent first, no priority last.
        "priority" => json!([{"priority": {"order": "Descending"}}, newest_updated]),
        other => bail!("Unknown sort {other}."),
    };
    Ok(json!({"first": LIMIT, "filter": f, "sort": sort}))
}

pub fn linear_list(key: &str, filter: &IssueFilter) -> Result<Vec<Issue>> {
    let query = format!("query($first: Int!, $filter: IssueFilter, $sort: [IssueSortInput!]) {{ issues(first: $first, filter: $filter, sort: $sort) {{ nodes {{ {ISSUE_FIELDS} }} }} }}");
    let data = graphql(key, &query, linear_list_variables(filter)?)?;
    Ok(parse_linear_issues(&data))
}

/// The issue as an agent's first prompt carries it: the description with the
/// discussion under it ([`linear_discussion`]). The Issues view reads the
/// two apart, through `issue_ops`.
pub fn linear_details(key: &str, id: &str) -> Result<Issue> {
    let query = format!("query($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} comments(first: {DISCUSSION_COMMENTS}) {{ nodes {{ body createdAt user {{ displayName name }} botActor {{ name }} }} pageInfo {{ hasNextPage }} }} }} }}");
    let data = graphql(key, &query, json!({"id": id}))?;
    let mut issue = parse_linear_issue(&data["issue"]).ok_or_else(|| anyhow!("Linear did not return that issue."))?;
    if let Some(discussion) = linear_discussion(&data["issue"]) {
        let description = issue.body.take().unwrap_or_default();
        issue.body = Some(format!("{}\n\n---\n\n{discussion}", description.trim_end()).trim_start().to_string());
    }
    Ok(issue)
}

/// The most comments a prompt carries, and roughly how much of them.
const DISCUSSION_COMMENTS: usize = 50;
const DISCUSSION_CHARS: usize = 12_000;

/// An issue's comments for an agent, oldest first, from a `comments`
/// connection read newest first (Linear's order). The newest are kept when
/// there are too many, and the cut is said with a link to the rest. `None`
/// when nobody commented.
pub fn linear_discussion(node: &Value) -> Option<String> {
    let newest_first = node["comments"]["nodes"].as_array().filter(|comments| !comments.is_empty())?;
    let mut kept = Vec::new();
    let mut size = 0;
    for comment in newest_first {
        let who = comment["user"]["displayName"].as_str().or_else(|| comment["user"]["name"].as_str()).or_else(|| comment["botActor"]["name"].as_str()).unwrap_or("someone");
        let when = comment["createdAt"].as_str().and_then(|at| at.get(..10)).map(|day| format!(" ({day})")).unwrap_or_default();
        let mut entry = format!("**{who}**{when}: {}", comment["body"].as_str().unwrap_or("").trim());
        if !kept.is_empty() && size + entry.len() > DISCUSSION_CHARS {
            break;
        }
        // Even the newest comment is cut to the cap.
        if entry.len() > DISCUSSION_CHARS {
            let mut end = DISCUSSION_CHARS;
            while !entry.is_char_boundary(end) {
                end -= 1;
            }
            entry.truncate(end);
            entry.push_str(&format!("\n\n…the rest of this comment is cut; read it at {}", node["url"].as_str().unwrap_or("the issue")));
        }
        size += entry.len();
        kept.push(entry);
    }
    let omitted = newest_first.len() - kept.len();
    let more = node["comments"]["pageInfo"]["hasNextPage"].as_bool() == Some(true);
    let url = node["url"].as_str().unwrap_or("");
    let mut text = String::from("## Comments\n");
    match (omitted, more) {
        (0, false) => {}
        (n, false) => text.push_str(&format!("\n…{n} earlier comment{} omitted; read {} at {url}\n", if n == 1 { "" } else { "s" }, if n == 1 { "it" } else { "them" })),
        _ => text.push_str(&format!("\n…earlier comments omitted; read them at {url}\n")),
    }
    for entry in kept.iter().rev() {
        text.push_str(&format!("\n{entry}\n"));
    }
    Some(text)
}

/// A Linear state type that means the issue is finished with, one way or another.
fn linear_closed(state_type: &str) -> bool {
    matches!(state_type, "completed" | "canceled" | "cancelled" | "duplicate")
}

/// The team's workflow state an issue moves to once its pull request is open:
/// the started state called "In Review", or failing that one with "review" in
/// its name. A team with no such state has nowhere to move it.
pub fn linear_review_state(data: &Value) -> Option<(String, String)> {
    let states = data["issue"]["team"]["states"]["nodes"].as_array()?;
    let named = |wanted: &dyn Fn(&str) -> bool| {
        states.iter().find_map(|state| {
            let name = state["name"].as_str()?;
            let open = !linear_closed(state["type"].as_str().unwrap_or(""));
            (open && wanted(&name.to_lowercase())).then(|| (state["id"].as_str().unwrap_or("").to_string(), name.to_string()))
        })
    };
    named(&|name| name == "in review").or_else(|| named(&|name| name.contains("review"))).filter(|(id, _)| !id.is_empty())
}

/// What moving a Linear issue to review did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinearReviewMove {
    Moved(String),
    /// Already there, or past it.
    Unchanged(String),
    NoReviewState,
}

/// Where the pipeline's move to review takes the issue, read from its state
/// and its team's states; `Err` is the issue left where it is. Never
/// backwards: an issue someone already closed stays closed, and one moved by
/// hand to a started state past review (a "QA" after "In Review") stays there.
pub fn linear_review_step(data: &Value) -> std::result::Result<(String, String), LinearReviewMove> {
    let Some((state_id, state_name)) = linear_review_state(data) else {
        return Err(LinearReviewMove::NoReviewState);
    };
    let state = &data["issue"]["state"];
    let current = state["name"].as_str().unwrap_or("").to_string();
    let state_type = state["type"].as_str().unwrap_or("");
    let review_position = data["issue"]["team"]["states"]["nodes"]
        .as_array()
        .and_then(|states| states.iter().find(|each| each["id"].as_str() == Some(state_id.as_str())))
        .and_then(|review| review["position"].as_f64());
    let past_review = state_type == "started" && matches!((state["position"].as_f64(), review_position), (Some(at), Some(review)) if at > review);
    if state["id"].as_str() == Some(state_id.as_str()) || linear_closed(state_type) || past_review {
        return Err(LinearReviewMove::Unchanged(current));
    }
    Ok((state_id, state_name))
}

/// Move a Linear issue to its team's review state. `id` is the issue's UUID
/// or its identifier (`ENG-42`); Linear takes either.
pub fn linear_move_to_review(key: &str, id: &str) -> Result<LinearReviewMove> {
    let data = graphql(
        key,
        "query($id: String!) { issue(id: $id) { id state { id name type position } team { states(first: 100) { nodes { id name type position } } } } }",
        json!({"id": id}),
    )?;
    let issue_id = data["issue"]["id"].as_str().ok_or_else(|| anyhow!("Linear did not return that issue."))?;
    let (state_id, state_name) = match linear_review_step(&data) {
        Ok(step) => step,
        Err(left) => return Ok(left),
    };
    let updated = graphql(
        key,
        "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
        json!({"id": issue_id, "stateId": state_id}),
    )?;
    if updated["issueUpdate"]["success"].as_bool() != Some(true) {
        bail!("Linear did not move the issue to {state_name}.");
    }
    Ok(LinearReviewMove::Moved(state_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cloud_projects_issues_are_its_repositorys_read_from_outside_any_checkout() {
        let project = Path::new("cloud:org_01H:github.com/acme/widgets.js");
        assert_eq!(cloud_project_repo(project).as_deref(), Some("acme/widgets.js"));
        assert_eq!(github_repo(project).as_deref(), Some("acme/widgets.js"));
        assert_eq!(gh_dir(project), std::env::temp_dir());
        // A blank project has no repository, and a local path is a checkout.
        for not_one in ["cloud:org_01H:blank/scratch", "cloud:org_01H:gitlab.com/acme/widgets", "cloud:org_01H:github.com/acme", "cloud:org_01H:github.com/acme/widgets/extra", "cloud:org_01H:github.com/../widgets", "/Users/me/widgets", "cloud:org_01H"] {
            assert_eq!(cloud_project_repo(Path::new(not_one)), None, "{not_one}");
        }
        assert_eq!(gh_dir(Path::new("/Users/me/widgets")), Path::new("/Users/me/widgets"));
    }

    #[test]
    fn the_review_state_is_in_review_or_the_nearest_thing_to_it() {
        let team = |states: Value| json!({"issue": {"team": {"states": {"nodes": states}}}});
        // The states of a real team, in the order Linear returned them, with one more that also mentions review.
        let usual = team(json!([
            {"id": "s4", "name": "In Review", "type": "started"},
            {"id": "s1", "name": "Todo", "type": "unstarted"},
            {"id": "s5", "name": "Done", "type": "completed"},
            {"id": "s6", "name": "Duplicate", "type": "duplicate"},
            {"id": "s2", "name": "In Progress", "type": "started"},
            {"id": "s0", "name": "Backlog", "type": "backlog"},
            {"id": "s7", "name": "Canceled", "type": "canceled"},
            {"id": "s3", "name": "Code Review", "type": "started"}
        ]));
        assert_eq!(linear_review_state(&usual), Some(("s4".into(), "In Review".into())));
        let renamed = team(json!([{"id": "s2", "name": "In Progress", "type": "started"}, {"id": "s3", "name": "Peer review", "type": "started"}]));
        assert_eq!(linear_review_state(&renamed), Some(("s3".into(), "Peer review".into())));
        // A finished state that happens to mention review is not where work in review goes.
        let closed = team(json!([{"id": "s9", "name": "Reviewed", "type": "completed"}, {"id": "s2", "name": "In Progress", "type": "started"}]));
        assert_eq!(linear_review_state(&closed), None);
        assert_eq!(linear_review_state(&json!({"issue": null})), None);
    }

    #[test]
    fn a_state_chosen_by_hand_while_a_pipeline_runs_is_never_moved_backwards() {
        let states = json!([
            {"id": "s0", "name": "Backlog", "type": "backlog", "position": 0.0},
            {"id": "s1", "name": "Todo", "type": "unstarted", "position": 1.0},
            {"id": "s2", "name": "In Progress", "type": "started", "position": 2.0},
            {"id": "s4", "name": "In Review", "type": "started", "position": 3.0},
            {"id": "s8", "name": "QA", "type": "started", "position": 4.0},
            {"id": "s5", "name": "Done", "type": "completed", "position": 5.0},
            {"id": "s7", "name": "Canceled", "type": "canceled", "position": 6.0}
        ]);
        // The issue as the pipeline reads it when its pull request opens, after someone picked `id` in the status picker.
        let picked = |id: &str| {
            let state = states.as_array().unwrap().iter().find(|each| each["id"] == id).unwrap().clone();
            json!({"issue": {"id": "issue-1", "state": state, "team": {"states": {"nodes": states.clone()}}}})
        };
        let to_review = Ok(("s4".to_string(), "In Review".to_string()));
        // Before review: the pipeline still moves it forward.
        for id in ["s0", "s1", "s2"] {
            assert_eq!(linear_review_step(&picked(id)), to_review, "{id}");
        }
        // At review, past it, or closed: left where the person put it.
        for (id, name) in [("s4", "In Review"), ("s8", "QA"), ("s5", "Done"), ("s7", "Canceled")] {
            assert_eq!(linear_review_step(&picked(id)), Err(LinearReviewMove::Unchanged(name.into())), "{id}");
        }
        // A team that reports no positions keeps the older rule.
        let mut unordered = picked("s8");
        unordered["issue"]["state"]["position"] = Value::Null;
        assert_eq!(linear_review_step(&unordered), to_review);
    }

    #[test]
    fn an_issue_is_named_by_number_key_or_url() {
        for (reference, provider, id) in [
            ("#433", "github", "433"),
            (" 433 ", "github", "433"),
            ("https://github.com/acme/widgets/issues/433", "github", "433"),
            ("https://github.com/acme/widgets/issues/433#issuecomment-1", "github", "433"),
            ("ENG-42", "linear", "ENG-42"),
            ("eng-42", "linear", "ENG-42"),
            ("https://linear.app/acme/issue/PRO-89/reuse-the-envelope", "linear", "PRO-89"),
        ] {
            assert_eq!(parse_issue_reference(reference, None), Ok((provider, id.to_string())), "{reference}");
        }
        assert_eq!(parse_issue_reference("433", Some("github")), Ok(("github", "433".to_string())));
        assert!(parse_issue_reference("433", Some("linear")).unwrap_err().contains("is a GitHub issue"));
        for not_an_issue in ["", "fix the login", "https://github.com/acme/widgets/pull/433", "https://linear.app/acme/project/x", "-42", "ENG-", "#"] {
            assert!(parse_issue_reference(not_an_issue, None).is_err(), "{not_an_issue}");
        }
        // A URL says which repository it is in; a bare number does not.
        assert_eq!(github_issue_url_repo("https://github.com/acme/widgets/issues/433").as_deref(), Some("acme/widgets"));
        assert_eq!(github_issue_url_repo(" https://github.com/Acme/Widgets/issues/433#issuecomment-1 ").as_deref(), Some("Acme/Widgets"));
        for no_repo in ["433", "#433", "ENG-42", "https://github.com/acme/widgets/pull/433", "https://linear.app/acme/issue/ENG-42"] {
            assert_eq!(github_issue_url_repo(no_repo), None, "{no_repo}");
        }
    }

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
        assert!(issues[1].assignees.is_empty());
    }

    #[test]
    fn github_lists_are_read_as_the_website_filters() {
        let filter = |value: Value| serde_json::from_value::<IssueFilter>(value).unwrap();
        let query = |value: Value| github_list_query("acme/widgets", &filter(value), || Ok("kim".into())).unwrap();
        let rest = |value: Value| match query(value) {
            GithubList::Rest(params) => params.into_iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>(),
            other => panic!("{other:?}"),
        };

        // The repository's own list, so a change shows at once: open, recently updated first.
        assert_eq!(rest(json!({})), ["state=open", "sort=updated", "direction=desc"]);
        assert_eq!(
            rest(json!({"state": "closed", "sort": "created_asc", "labels": ["bug", " ", "help wanted"], "assignee": {"kind": "person", "id": "sam"}})),
            ["state=closed", "sort=created", "direction=asc", "assignee=sam", "labels=bug,help wanted"]
        );
        assert_eq!(rest(json!({"state": "all", "sort": "created", "assignee": {"kind": "unassigned"}})), ["state=all", "sort=created", "direction=desc", "assignee=none"]);
        // The reader, by login; asked for only then. The older "Assigned to me" switch still works.
        assert_eq!(rest(json!({"assignedToMe": true})), ["state=open", "sort=updated", "direction=desc", "assignee=kim"]);
        assert_eq!(rest(json!({"assignedToMe": true, "assignee": {"kind": "person", "id": "alex"}}))[3], "assignee=alex");
        assert!(matches!(github_list_query("acme/widgets", &filter(json!({})), || bail!("not asked")), Ok(GithubList::Rest(_))));

        // Words need GitHub's search.
        let GithubList::Search(args) = query(json!({"state": "closed", "search": " login ", "labels": ["bug"], "assignee": {"kind": "unassigned"}, "sort": "created"})) else { panic!() };
        let after = |flag: &str| args.iter().position(|arg| arg == flag).map(|at| args[at + 1].clone());
        assert_eq!(after("--repo").as_deref(), Some("acme/widgets"));
        assert_eq!(after("--state").as_deref(), Some("closed"));
        assert_eq!(after("--label").as_deref(), Some("bug"));
        assert_eq!(after("--search").as_deref(), Some("no:assignee login sort:created-desc"));
        assert!(after("--json").unwrap().contains("stateReason"));
        let GithubList::Search(mine) = query(json!({"search": "x", "assignee": {"kind": "me"}})) else { panic!() };
        assert!(mine.windows(2).any(|pair| pair[0] == "--assignee" && pair[1] == "@me"));

        for refused in [json!({"state": "started"}), json!({"sort": "priority"}), json!({"sort": "sideways"})] {
            assert!(github_list_query("acme/widgets", &filter(refused.clone()), || Ok("kim".into())).is_err(), "{refused}");
        }
    }

    #[test]
    fn the_repositorys_list_leaves_out_pull_requests() {
        let rows = json!([
            {"number": 5, "node_id": "I_5", "title": "Crash", "state": "closed", "state_reason": "not_planned", "html_url": "https://github.com/acme/widgets/issues/5", "updated_at": "2026-10-01T00:00:00Z",
             "labels": [{"name": "bug", "color": "d73a4a"}], "assignees": [{"login": "sam", "avatar_url": "https://avatars/sam"}], "body": "long"},
            {"number": 6, "title": "A pull request", "state": "open", "pull_request": {"url": "u"}, "labels": [], "assignees": []},
            {"number": 7, "title": "Open one", "state": "open", "state_reason": null, "labels": [], "assignees": []}
        ]);
        let issues: Vec<Issue> = rows.as_array().unwrap().iter().filter_map(parse_github_rest_issue).collect();
        assert_eq!(issues.iter().map(|issue| issue.number).collect::<Vec<_>>(), [5, 7]);
        let crash = &issues[0];
        assert_eq!((crash.state.as_str(), crash.state_type.as_str(), crash.identifier.as_str()), ("Closed", "canceled", "#5"));
        assert_eq!(crash.labels[0].color, "d73a4a");
        assert_eq!(crash.assignees[0].id, "sam");
        assert_eq!(crash.assignee.as_ref().unwrap().name, "sam");
        assert_eq!(crash.url, "https://github.com/acme/widgets/issues/5");
        // Lists leave the body to the detail read.
        assert!(crash.body.is_none());
        assert_eq!(issues[1].state_type, "open");
    }

    /// Live, opt-in (`TERMINALX_LIVE_ISSUE_SANDBOX=1 cargo test live_list_filters -- --ignored --nocapture`):
    /// the list's filters against the real `gh` login and Linear key. GitHub's
    /// lists are compared with the website's own issue search for the same
    /// query (a few seconds behind any change, so nothing here changes first); Linear's are checked against what each filter means. The only
    /// writes are to the two sandbox issues (#527, PRO-101): each is closed or
    /// finished, found in the closed list, and put back where it was.
    #[test]
    #[ignore]
    #[cfg(feature = "desktop")]
    fn live_list_filters_match_the_websites() {
        use crate::issue_ops::{details, options, set_state, Provider, StateChange, Target};
        if std::env::var("TERMINALX_LIVE_ISSUE_SANDBOX").as_deref() != Ok("1") {
            return;
        }
        let repo_dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let repo = github_repo(&repo_dir).unwrap();
        let filter = |value: Value| serde_json::from_value::<IssueFilter>(value).unwrap();
        let numbers = |issues: &[Issue]| issues.iter().map(|issue| issue.number).collect::<Vec<_>>();
        // What github.com/<repo>/issues?q=… shows: the search API, a page of the list's size, with the times it sorts by.
        let website = |query: &str| -> Vec<(i64, String, String)> {
            let out = run_gh(&repo_dir, &["api", "-X", "GET", "search/issues", "-f", &format!("q=repo:{repo} is:issue {query}"), "-f", &format!("per_page={LIMIT}"), "--jq", "[.items[] | [.number, .created_at, .updated_at]]"]).unwrap();
            serde_json::from_value::<Vec<(i64, String, String)>>(serde_json::from_str(&out).unwrap()).unwrap()
        };
        let any_label = github_list(&repo_dir, &filter(json!({"state": "all"}))).unwrap().into_iter().find_map(|issue| issue.labels.first().map(|label| label.name.clone()));
        let mut cases = vec![
            (json!({}), "is:open sort:updated-desc".to_string()),
            (json!({"state": "closed", "sort": "created"}), "is:closed sort:created-desc".into()),
            (json!({"state": "all", "sort": "created_asc"}), "sort:created-asc".into()),
            (json!({"assignee": {"kind": "unassigned"}}), "is:open no:assignee sort:updated-desc".into()),
            (json!({"state": "all", "assignee": {"kind": "me"}}), "assignee:@me sort:updated-desc".into()),
            (json!({"state": "all", "search": "sandbox"}), "sandbox sort:updated-desc".into()),
        ];
        if let Some(label) = &any_label {
            cases.push((json!({"state": "all", "labels": [label]}), format!("label:\"{label}\" sort:updated-desc")));
        }
        for (asked, query) in cases {
            let listed = numbers(&github_list(&repo_dir, &filter(asked.clone())).unwrap());
            let shown = website(&query);
            // The same issues, in the same order of the time sorted by; issues made in the same second may come either way round.
            let mut same = listed.clone();
            same.sort();
            let mut theirs: Vec<i64> = shown.iter().map(|each| each.0).collect();
            theirs.sort();
            assert_eq!(same, theirs, "{asked} against {query}");
            let by_created = query.contains("sort:created");
            let time = |number: i64| shown.iter().find(|each| each.0 == number).map(|each| if by_created { each.1.clone() } else { each.2.clone() });
            let times: Vec<_> = listed.iter().map(|number| time(*number)).collect();
            let expected: Vec<_> = shown.iter().map(|each| Some(if by_created { each.1.clone() } else { each.2.clone() })).collect();
            assert_eq!(times, expected, "{asked} against {query}: order");
            println!("GitHub {asked}: {} issues, the same as the website's \"{query}\"", listed.len());
        }

        let key = crate::store::settings::load().linear_api_key.filter(|key| !key.trim().is_empty()).expect("a Linear key in Settings");
        let me = linear_viewer_id(&key).unwrap();
        type Holds = Box<dyn Fn(&Issue) -> bool>;
        let checks: Vec<(Value, Holds)> = vec![
            (json!({}), Box::new(|issue: &Issue| !matches!(issue.state_type.as_str(), "completed" | "canceled"))),
            (json!({"state": "completed"}), Box::new(|issue: &Issue| issue.workflow_state_type.as_deref() == Some("completed"))),
            (json!({"state": "backlog"}), Box::new(|issue: &Issue| issue.workflow_state_type.as_deref() == Some("backlog"))),
            (json!({"state": "all", "assignee": {"kind": "unassigned"}}), Box::new(|issue: &Issue| issue.assignee.is_none())),
            (json!({"state": "all", "assignee": {"kind": "me"}}), Box::new(move |issue: &Issue| issue.assignees.iter().any(|user| user.id == me))),
            (json!({"state": "all", "labels": ["Bug", "Feature"]}), Box::new(|issue: &Issue| issue.labels.iter().any(|label| label.name == "Bug" || label.name == "Feature"))),
            (json!({"state": "all", "search": "PRO-101"}), Box::new(|issue: &Issue| issue.identifier == "PRO-101")),
        ];
        for (asked, holds) in checks {
            let listed = linear_list(&key, &filter(asked.clone())).unwrap();
            assert!(listed.iter().all(&holds), "{asked}");
            println!("Linear {asked}: {} issues, each matching", listed.len());
        }
        // The same request as the list's, read for the priorities the list doesn't carry.
        let asked = linear_list_variables(&filter(json!({"state": "all", "sort": "priority"}))).unwrap();
        let data = graphql(&key, "query($first: Int!, $filter: IssueFilter, $sort: [IssueSortInput!]) { issues(first: $first, filter: $filter, sort: $sort) { nodes { priority } } }", asked).unwrap();
        let ranks: Vec<i64> = data["issues"]["nodes"].as_array().unwrap().iter().map(|node| node["priority"].as_f64().unwrap_or(0.0) as i64).collect();
        let rank = |priority: i64| if priority == 0 { 5 } else { priority };
        assert!(ranks.windows(2).all(|pair| rank(pair[0]) <= rank(pair[1])), "{ranks:?}");
        println!("Linear by priority: {} issues, urgent first and none last", ranks.len());
        let oldest = linear_list(&key, &filter(json!({"state": "all", "sort": "created_asc"}))).unwrap();
        let newest = linear_list(&key, &filter(json!({"state": "all", "sort": "created"}))).unwrap();
        assert_ne!(oldest.first().map(|issue| &issue.id), newest.first().map(|issue| &issue.id));
        println!("Linear oldest first {:?}, newest first {:?}", oldest.first().map(|issue| &issue.identifier), newest.first().map(|issue| &issue.identifier));

        // A closed sandbox issue is listed under its closed state and reopened.
        let github = Target::resolve(&repo_dir, Provider::Github).unwrap();
        let before = details(&github, "527").unwrap();
        assert!(before.issue.title.starts_with("[TerminalX test]") && before.issue.state_type == "open", "only the open sandbox issue");
        // Every GitHub list lags a change by a second or two (the search index the most); the lag is measured and the
        // sandbox is reopened before anything is asserted.
        let lag = |state: &str| {
            let started = std::time::Instant::now();
            (0..15).find_map(|attempt| {
                if attempt > 0 {
                    std::thread::sleep(Duration::from_secs(1));
                }
                let issues = github_list(&repo_dir, &filter(json!({"state": state}))).ok()?;
                issues.iter().find(|issue| issue.number == 527).map(|issue| (issue.state_type.clone(), started.elapsed().as_secs()))
            })
        };
        set_state(&github, "527", &StateChange::Close { reason: crate::issue_ops::CloseReason::NotPlanned }).unwrap();
        let closed_at = lag("closed");
        let reopened = set_state(&github, "527", &StateChange::Reopen).unwrap();
        let open_at = lag("open");
        println!("GitHub #527 under Closed after closing: {closed_at:?}; under Open after reopening: {open_at:?} (state type, seconds)");
        let listed_closed = matches!(&closed_at, Some((kind, _)) if kind == "canceled");
        let listed_open = open_at.is_some();
        assert!(listed_closed, "#527 was not under Closed right after closing");
        assert!(listed_open, "#527 was not under Open right after reopening");
        assert_eq!(reopened.issue.state_type, "open");
        println!("GitHub #527: closed as not planned, listed under Closed as canceled, reopened, listed under Open");

        let linear = Target::resolve(&repo_dir, Provider::Linear).unwrap();
        let before = details(&linear, "PRO-101").unwrap();
        assert!(before.issue.title.starts_with("[TerminalX test]"), "only the sandbox issue");
        let was = before.state_id.clone().unwrap();
        let states = options(&linear, Some("PRO-101"), None, false).unwrap().states;
        let done = states.iter().find(|state| state.state_type == "completed").unwrap();
        set_state(&linear, "PRO-101", &StateChange::WorkflowState { state_id: done.id.clone() }).unwrap();
        let finished = linear_list(&key, &filter(json!({"state": "completed", "search": "PRO-101"})));
        let back = set_state(&linear, "PRO-101", &StateChange::WorkflowState { state_id: was.clone() }).unwrap();
        assert!(finished.unwrap().iter().any(|issue| issue.identifier == "PRO-101"));
        assert_eq!(back.state_id.as_deref(), Some(was.as_str()));
        println!("Linear PRO-101: moved to {}, listed under Completed, moved back to {}", done.name, back.issue.state);
    }

    #[test]
    fn a_closed_github_issue_is_canceled_when_not_planned() {
        let v = json!([
            {"number": 1, "title": "a", "state": "CLOSED", "stateReason": "NOT_PLANNED", "labels": [], "assignees": [], "updatedAt": "", "url": ""},
            {"number": 2, "title": "b", "state": "CLOSED", "stateReason": "COMPLETED", "labels": [], "assignees": [], "updatedAt": "", "url": ""},
            {"number": 3, "title": "c", "state": "CLOSED", "labels": [], "assignees": [], "updatedAt": "", "url": ""},
            {"number": 4, "title": "d", "state": "OPEN", "stateReason": "REOPENED", "labels": [], "assignees": [], "updatedAt": "", "url": ""}
        ]);
        let kinds: Vec<_> = parse_github_issues(&v).into_iter().map(|issue| (issue.state, issue.state_type, issue.workflow_state_type)).collect();
        assert_eq!(
            kinds,
            [("Closed".into(), "canceled".into(), None), ("Closed".into(), "completed".into(), None), ("Closed".into(), "completed".into(), None), ("Open".into(), "open".into(), None)]
        );
    }

    #[test]
    fn linear_lists_are_filtered_and_sorted_on_linears_side() {
        let vars = |value: Value| linear_list_variables(&serde_json::from_value::<IssueFilter>(value).unwrap()).unwrap();

        // "Open": neither completed nor canceled, recently updated first.
        let plain = vars(json!({}));
        assert_eq!(plain["filter"], json!({"state": {"type": {"nin": ["completed", "canceled"]}}}));
        assert_eq!(plain["sort"], json!([{"updatedAt": {"order": "Descending"}}]));
        assert_eq!(plain["first"], LIMIT);

        assert_eq!(vars(json!({"state": "all"}))["filter"], json!({}));
        assert_eq!(vars(json!({"state": "completed"}))["filter"]["state"], json!({"type": {"eq": "completed"}}));
        assert_eq!(vars(json!({"state": "backlog"}))["filter"]["state"], json!({"type": {"eq": "backlog"}}));

        let narrowed = vars(json!({"assignee": {"kind": "person", "id": "user-1"}, "teamId": "team-1", "labels": ["Bug", "Feature"], "sort": "priority"}));
        assert_eq!(narrowed["filter"]["assignee"], json!({"id": {"eq": "user-1"}}));
        assert_eq!(narrowed["filter"]["team"], json!({"id": {"eq": "team-1"}}));
        assert_eq!(narrowed["filter"]["labels"], json!({"some": {"name": {"in": ["Bug", "Feature"]}}}));
        assert_eq!(narrowed["sort"], json!([{"priority": {"order": "Descending"}}, {"updatedAt": {"order": "Descending"}}]));
        assert_eq!(vars(json!({"assignee": {"kind": "unassigned"}}))["filter"]["assignee"], json!({"null": true}));
        assert_eq!(vars(json!({"assignedToMe": true}))["filter"]["assignee"], json!({"isMe": {"eq": true}}));
        assert_eq!(vars(json!({"sort": "created"}))["sort"], json!([{"createdAt": {"order": "Descending"}}]));
        assert_eq!(vars(json!({"sort": "created_asc"}))["sort"], json!([{"createdAt": {"order": "Ascending"}}]));

        // Search finds the title, or the issue by its number, past the first page.
        assert_eq!(vars(json!({"search": " login "}))["filter"]["or"], json!([{"title": {"containsIgnoreCase": "login"}}]));
        assert_eq!(vars(json!({"search": "42"}))["filter"]["or"][1], json!({"number": {"eq": 42}}));
        assert_eq!(vars(json!({"search": "eng-42"}))["filter"]["or"][1], json!({"and": [{"number": {"eq": 42}}, {"team": {"key": {"eqIgnoreCase": "eng"}}}]}));

        for refused in [json!({"state": "closed"}), json!({"state": "done"}), json!({"sort": "sideways"})] {
            assert!(linear_list_variables(&serde_json::from_value::<IssueFilter>(refused.clone()).unwrap()).is_err(), "{refused}");
        }
    }

    #[test]
    fn github_list_keeps_every_assignee() {
        let v: Value = serde_json::from_str(r#"[{"number":9,"title":"Shared","state":"OPEN","labels":[],"assignees":[{"login":"sam","name":"Sam"},{"login":"alex","name":""},{"login":"robin"},{"name":"no login"}],"updatedAt":"2026-09-01T10:00:00Z","url":"u"}]"#).unwrap();
        let issue = &parse_github_issues(&v)[0];
        assert_eq!(issue.assignees.iter().map(|user| (user.id.as_str(), user.name.as_str())).collect::<Vec<_>>(), [("sam", "Sam"), ("alex", "alex"), ("robin", "robin")]);
        assert_eq!(issue.assignees[1].login.as_deref(), Some("alex"));
        assert_eq!(issue.assignees[2].avatar_url.as_deref(), Some("https://github.com/robin.png?size=64"));
        assert_eq!(issue.assignee.as_ref().unwrap().name, "Sam");
        let wire = serde_json::to_value(issue).unwrap();
        assert_eq!(wire["assignees"].as_array().unwrap().len(), 3);
        assert_eq!(wire["assignees"][0]["avatarUrl"], "https://github.com/sam.png?size=64");
    }

    #[test]
    fn the_agents_discussion_is_oldest_first_and_says_what_it_left_out() {
        let comment = |who: &str, body: &str, at: &str| json!({"body": body, "createdAt": at, "user": {"displayName": who}});
        // Linear reads them newest first.
        let node = json!({"url": "https://linear.app/acme/issue/ENG-1", "comments": {"nodes": [
            comment("Alex", "Fixed on main.", "2026-09-03T10:00:00.000Z"),
            {"body": "PR opened.", "createdAt": "2026-09-02T10:00:00.000Z", "user": null, "botActor": {"name": "GitHub"}},
            comment("Kim", "Seen it on staging too.", "2026-09-01T10:00:00.000Z"),
        ], "pageInfo": {"hasNextPage": false}}});
        assert_eq!(
            linear_discussion(&node).unwrap(),
            "## Comments\n\n**Kim** (2026-09-01): Seen it on staging too.\n\n**GitHub** (2026-09-02): PR opened.\n\n**Alex** (2026-09-03): Fixed on main.\n"
        );
        assert_eq!(linear_discussion(&json!({"comments": {"nodes": []}})), None);

        let long = "x".repeat(DISCUSSION_CHARS / 2);
        let crowded = json!({"url": "https://linear.app/acme/issue/ENG-1", "comments": {"nodes": [
            comment("Alex", &long, "2026-09-03T10:00:00.000Z"),
            comment("Kim", &long, "2026-09-02T10:00:00.000Z"),
            comment("Sam", "first", "2026-09-01T10:00:00.000Z"),
        ], "pageInfo": {"hasNextPage": false}}});
        let text = linear_discussion(&crowded).unwrap();
        assert!(text.contains("…2 earlier comments omitted; read them at https://linear.app/acme/issue/ENG-1"), "{text}");
        assert!(text.contains("**Alex**") && !text.contains("**Kim**") && !text.contains("first"));

        // A single huge comment is cut too.
        let huge = json!({"url": "https://linear.app/acme/issue/ENG-1", "comments": {"nodes": [comment("Alex", &"é".repeat(DISCUSSION_CHARS), "2026-09-03T10:00:00.000Z")], "pageInfo": {"hasNextPage": false}}});
        let text = linear_discussion(&huge).unwrap();
        assert!(text.len() < DISCUSSION_CHARS + 200, "{}", text.len());
        assert!(text.ends_with("…the rest of this comment is cut; read it at https://linear.app/acme/issue/ENG-1\n"));

        let more = json!({"url": "u", "comments": {"nodes": [comment("Alex", "latest", "2026-09-03T10:00:00.000Z")], "pageInfo": {"hasNextPage": true}}});
        assert!(linear_discussion(&more).unwrap().contains("…earlier comments omitted; read them at u"));
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
        assert_eq!(i.workflow_state_type.as_deref(), Some("started"));
        assert_eq!(i.labels[0].color, "eb5757");
        assert_eq!(i.assignee.as_ref().unwrap().name, "Sam");
        // An assignee read without an id (an older query) cannot be named to Linear, so is not listed as one.
        assert!(i.assignees.is_empty());
        assert_eq!(i.team.as_ref().unwrap().key, "ENG");
        assert_eq!(i.body.as_deref(), Some("Users get logged out."));
        let teams = parse_linear_teams(&serde_json::from_str::<Value>(r#"{"teams":{"nodes":[{"id":"t1","key":"ENG","name":"Engineering"}]}}"#).unwrap());
        assert_eq!(teams[0].key, "ENG");
    }
}
