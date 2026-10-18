//! GitHub issue operations, through `gh api` REST with the reader's own login.
//! REST rather than `gh issue view` / `gh issue edit`, which fail on
//! repositories that still use classic Projects.

use std::io::Write;
use std::path::Path;
use std::process::Stdio;

use serde_json::Value;

use super::{CloseReason, CommentsPage, DescriptionEdit, IssueCapabilities, IssueComment, IssueCreate, IssueDetails, IssueOpError, IssueOpErrorKind, IssueOptions, IssueUser, OpResult, Provider, StateChange};
use crate::issues::{Issue, IssueAssignee, IssueLabel};

const GITHUB: Provider = Provider::Github;

/// `gh api <path>` with an optional JSON body on stdin. A failure is
/// classified from what gh printed, and what it printed is dropped.
pub(crate) fn gh_api(cwd: &Path, method: &str, path: &str, body: Option<&Value>) -> OpResult<Value> {
    let mut command = crate::issues::gh().map_err(|_| IssueOpError::with_message(IssueOpErrorKind::NotSignedIn, "The GitHub CLI (gh) is not installed or not on PATH."))?;
    command.current_dir(cwd).args(["api", "-X", method, "-H", "Accept: application/vnd.github+json", path]);
    if body.is_some() {
        command.args(["--input", "-"]);
    }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|_| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))?;
    if let (Some(body), Some(mut stdin)) = (body, child.stdin.take()) {
        stdin.write_all(body.to_string().as_bytes()).map_err(|_| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))?;
    }
    let out = child.wait_with_output().map_err(|_| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))?;
    if !out.status.success() {
        let printed = format!("{}\n{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
        return Err(IssueOpError::new(classify(&printed), GITHUB));
    }
    if out.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&out.stdout).map_err(|_| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))
}

/// The kind of a failed `gh api` call, from its stderr and the reply it printed.
pub fn classify(printed: &str) -> IssueOpErrorKind {
    let text = printed.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if has(&["gh auth login", "not logged into", "http 401", "bad credentials", "requires authentication"]) {
        IssueOpErrorKind::NotSignedIn
    } else if has(&["rate limit", "http 429"]) {
        IssueOpErrorKind::RateLimited
    } else if has(&["scope", "resource not accessible by personal access token", "resource not accessible by integration"]) {
        IssueOpErrorKind::MissingScope
    } else if has(&["http 403", "must have admin rights", "must have push access"]) {
        IssueOpErrorKind::Forbidden
    } else if has(&["http 404", "http 410", "not found"]) {
        IssueOpErrorKind::NotFound
    } else if has(&["http 409", "http 412", "conflict"]) {
        IssueOpErrorKind::Conflict
    } else if has(&["error connecting to", "could not resolve host", "dial tcp", "no such host", "connection refused", "connection reset", "timeout", "timed out", "tls handshake", "network is unreachable"]) {
        IssueOpErrorKind::Network
    } else if has(&["http 422", "validation failed"]) {
        IssueOpErrorKind::Invalid
    } else {
        IssueOpErrorKind::Other
    }
}

fn user(v: &Value) -> Option<IssueUser> {
    let login = v["login"].as_str()?;
    Some(IssueUser {
        id: login.into(),
        name: v["name"].as_str().filter(|name| !name.is_empty()).unwrap_or(login).into(),
        login: Some(login.into()),
        avatar_url: v["avatar_url"].as_str().map(String::from),
    })
}

/// An issue as `GET /repos/{repo}/issues/{number}` answers it.
pub fn parse_issue(v: &Value, repo: &str) -> Option<IssueDetails> {
    let number = v["number"].as_i64()?;
    let closed = v["state"].as_str() == Some("closed");
    let close_reason = match (closed, v["state_reason"].as_str()) {
        (true, Some("not_planned")) => Some(CloseReason::NotPlanned),
        (true, _) => Some(CloseReason::Completed),
        _ => None,
    };
    let labels = v["labels"]
        .as_array()
        .map(|labels| {
            labels
                .iter()
                .filter_map(|label| {
                    let name = label["name"].as_str()?;
                    Some(IssueLabel { id: Some(name.into()), name: name.into(), color: label["color"].as_str().unwrap_or("").trim_start_matches('#').into() })
                })
                .collect()
        })
        .unwrap_or_default();
    let assignees: Vec<IssueUser> = v["assignees"].as_array().map(|all| all.iter().filter_map(user).collect()).unwrap_or_default();
    let description = v["body"].as_str().unwrap_or("").to_string();
    let issue = Issue {
        provider: "github".into(),
        id: number.to_string(),
        node_id: v["node_id"].as_str().map(String::from),
        identifier: format!("#{number}"),
        number,
        title: v["title"].as_str().unwrap_or("").into(),
        url: v["html_url"].as_str().unwrap_or("").into(),
        state: if closed { "Closed" } else { "Open" }.into(),
        state_type: match close_reason {
            Some(CloseReason::NotPlanned) => "canceled",
            Some(CloseReason::Completed) => "completed",
            None => "open",
        }
        .into(),
        labels,
        assignee: assignees.first().map(|first| IssueAssignee { name: first.name.clone(), avatar_url: first.avatar_url.clone() }),
        updated_at: v["updated_at"].as_str().unwrap_or("").into(),
        body: Some(description.clone()),
        team: None,
    };
    Some(IssueDetails {
        issue,
        description,
        state_id: None,
        state_color: None,
        close_reason,
        assignees,
        priority: None,
        author: user(&v["user"]),
        created_at: v["created_at"].as_str().unwrap_or("").into(),
        repo: Some(repo.into()),
        capabilities: IssueCapabilities::of(GITHUB),
    })
}

fn issue_number(id: &str) -> OpResult<&str> {
    let id = id.trim().trim_start_matches('#');
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A GitHub issue is named by its number."));
    }
    Ok(id)
}

pub fn details(cwd: &Path, repo: &str, id: &str) -> OpResult<IssueDetails> {
    let number = issue_number(id)?;
    let v = gh_api(cwd, "GET", &format!("repos/{repo}/issues/{number}"), None)?;
    // The issues endpoint also answers for pull requests.
    if v.get("pull_request").is_some() {
        return Err(IssueOpError::with_message(IssueOpErrorKind::NotFound, "That number is a pull request, not an issue."));
    }
    parse_issue(&v, repo).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))
}

pub fn comments(_cwd: &Path, _repo: &str, _id: &str, _cursor: Option<&str>) -> OpResult<CommentsPage> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn options(_cwd: &Path, _repo: &str, _refresh: bool) -> OpResult<IssueOptions> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn comment_add(_cwd: &Path, _repo: &str, _id: &str, _body: &str) -> OpResult<IssueComment> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn comment_edit(_cwd: &Path, _repo: &str, _id: &str, _comment_id: &str, _body: &str) -> OpResult<IssueComment> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn comment_delete(_cwd: &Path, _repo: &str, _id: &str, _comment_id: &str) -> OpResult<()> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn set_state(_cwd: &Path, _repo: &str, _id: &str, _change: &StateChange) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn set_assignees(_cwd: &Path, _repo: &str, _id: &str, _assignees: &[String]) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn set_labels(_cwd: &Path, _repo: &str, _id: &str, _labels: &[String]) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn set_title(_cwd: &Path, _repo: &str, _id: &str, _title: &str) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn set_description(_cwd: &Path, _repo: &str, _id: &str, _edit: &DescriptionEdit) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(GITHUB))
}

pub fn create(_cwd: &Path, _repo: &str, _input: &IssueCreate) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(GITHUB))
}
