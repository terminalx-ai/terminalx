//! GitHub issue operations, through `gh api` REST with the reader's own login.
//! REST rather than `gh issue view` / `gh issue edit`, which fail on
//! repositories that still use classic Projects.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};

use serde_json::{json, Value};

use super::{CloseReason, CommentsPage, DescriptionEdit, IssueCapabilities, IssueComment, IssueCreate, IssueDetails, IssueOpError, IssueOpErrorKind, IssueOptions, IssueUser, LabelOption, OpResult, Provider, StateChange};
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
        workflow_state_type: None,
        labels,
        assignee: assignees.first().map(|first| IssueAssignee { name: first.name.clone(), avatar_url: first.avatar_url.clone() }),
        assignees,
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
        priority: None,
        author: user(&v["user"]),
        created_at: v["created_at"].as_str().unwrap_or("").into(),
        repo: Some(repo.into()),
        capabilities: IssueCapabilities::of(GITHUB),
    })
}


// ------------------------------------------------------------------ transport

/// One `gh api` call: method, path, optional JSON body. The commands use
/// [`gh_api`]; tests stand in recorded replies.
pub(crate) type Api<'a> = dyn FnMut(&str, &str, Option<&Value>) -> OpResult<Value> + 'a;

fn gh(cwd: &Path) -> impl FnMut(&str, &str, Option<&Value>) -> OpResult<Value> + '_ {
    move |method, path, body| gh_api(cwd, method, path, body)
}

/// Lists ask for this many items a page.
const PAGE_SIZE: usize = 100;
/// Comments come this many to a page.
const COMMENTS_PAGE_SIZE: usize = 50;
/// Assignable users and labels stop after this many pages.
const MAX_PAGES: usize = 10;

/// Every page of a list endpoint, up to [`MAX_PAGES`].
fn all_pages(api: &mut Api, path: &str) -> OpResult<Vec<Value>> {
    let mut all = Vec::new();
    for page in 1..=MAX_PAGES {
        let reply = api("GET", &format!("{path}?per_page={PAGE_SIZE}&page={page}"), None)?;
        let items = reply.as_array().cloned().ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))?;
        let full = items.len() >= PAGE_SIZE;
        all.extend(items);
        if !full {
            break;
        }
    }
    Ok(all)
}

// ------------------------------------------------------------------ session cache

/// What the reader may do in a repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Access {
    /// The `gh` login's own login.
    pub viewer: String,
    /// Write access, which lets the reader edit and delete anyone's comments.
    pub moderates: bool,
}

/// Picker options and access per repository, kept for the session. Asking
/// for options with `refresh` reads both again.
#[derive(Default)]
pub(crate) struct Session {
    options: HashMap<String, IssueOptions>,
    access: HashMap<String, Access>,
}

static SESSION: LazyLock<Mutex<Session>> = LazyLock::new(Default::default);

fn lock(session: &Mutex<Session>) -> std::sync::MutexGuard<'_, Session> {
    session.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn access(api: &mut Api, session: &Mutex<Session>, repo: &str) -> OpResult<Access> {
    let key = repo.to_ascii_lowercase();
    if let Some(access) = lock(session).access.get(&key) {
        return Ok(access.clone());
    }
    let viewer = api("GET", "user", None)?["login"].as_str().map(String::from).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::NotSignedIn, GITHUB))?;
    let permissions = api("GET", &format!("repos/{repo}"), None)?["permissions"].clone();
    let moderates = ["admin", "maintain", "push"].iter().any(|level| permissions[level].as_bool() == Some(true));
    let access = Access { viewer, moderates };
    lock(session).access.insert(key, access.clone());
    Ok(access)
}

// ------------------------------------------------------------------ parsing

/// A comment as the issue comments endpoints answer it.
pub fn parse_comment(v: &Value, access: &Access) -> Option<IssueComment> {
    let id = v["id"].as_i64()?;
    let author = user(&v["user"]);
    let created_at = v["created_at"].as_str().unwrap_or("").to_string();
    let edited_at = v["updated_at"].as_str().filter(|updated| !same_time(updated, &created_at)).map(String::from);
    let own = author.as_ref().is_some_and(|author| author.id.eq_ignore_ascii_case(&access.viewer));
    Some(IssueComment {
        id: id.to_string(),
        author,
        body: v["body"].as_str().unwrap_or("").into(),
        created_at,
        edited_at,
        url: v["html_url"].as_str().map(String::from),
        viewer_can_edit: own || access.moderates,
        viewer_can_delete: own || access.moderates,
    })
}

fn label_option(v: &Value) -> Option<LabelOption> {
    // An archived label can't be given to an issue.
    if !v["archived_at"].is_null() {
        return None;
    }
    let name = v["name"].as_str()?;
    Some(LabelOption {
        id: name.into(),
        name: name.into(),
        color: v["color"].as_str().unwrap_or("").trim_start_matches('#').into(),
        description: v["description"].as_str().filter(|text| !text.is_empty()).map(String::from),
        group: None,
        group_id: None,
        is_group: false,
    })
}

/// The picker options from a repository's assignable users and labels.
pub fn parse_options(assignees: &[Value], labels: &[Value]) -> IssueOptions {
    IssueOptions {
        provider: GITHUB,
        states: Vec::new(),
        close_reasons: vec![CloseReason::Completed, CloseReason::NotPlanned],
        members: assignees.iter().filter_map(user).collect(),
        labels: labels.iter().filter_map(label_option).collect(),
        priorities: Vec::new(),
        capabilities: IssueCapabilities::of(GITHUB),
    }
}

/// Two timestamps for the same instant, however each spells it.
fn same_time(a: &str, b: &str) -> bool {
    match (chrono::DateTime::parse_from_rfc3339(a.trim()), chrono::DateTime::parse_from_rfc3339(b.trim())) {
        (Ok(a), Ok(b)) => a == b,
        _ => a.trim() == b.trim(),
    }
}

/// Two descriptions with the same text, whatever their line endings.
fn same_text(a: &str, b: &str) -> bool {
    a.replace("\r\n", "\n").trim_end() == b.replace("\r\n", "\n").trim_end()
}

fn issue_number(id: &str) -> OpResult<&str> {
    let id = id.trim().trim_start_matches('#');
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A GitHub issue is named by its number."));
    }
    Ok(id)
}

fn comment_number(id: &str) -> OpResult<&str> {
    let id = id.trim();
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A GitHub comment is named by its number."));
    }
    Ok(id)
}

fn issue_from(v: &Value, repo: &str) -> OpResult<IssueDetails> {
    parse_issue(v, repo).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))
}

// ------------------------------------------------------------------ operations

pub fn details(cwd: &Path, repo: &str, id: &str) -> OpResult<IssueDetails> {
    details_with(&mut gh(cwd), repo, id)
}

pub fn comments(cwd: &Path, repo: &str, id: &str, cursor: Option<&str>) -> OpResult<CommentsPage> {
    comments_with(&mut gh(cwd), &SESSION, repo, id, cursor)
}

pub fn options(cwd: &Path, repo: &str, refresh: bool) -> OpResult<IssueOptions> {
    options_with(&mut gh(cwd), &SESSION, repo, refresh)
}

pub fn comment_add(cwd: &Path, repo: &str, id: &str, body: &str) -> OpResult<IssueComment> {
    comment_add_with(&mut gh(cwd), repo, id, body)
}

pub fn comment_edit(cwd: &Path, repo: &str, id: &str, comment_id: &str, body: &str) -> OpResult<IssueComment> {
    comment_edit_with(&mut gh(cwd), repo, id, comment_id, body)
}

pub fn comment_delete(cwd: &Path, repo: &str, id: &str, comment_id: &str) -> OpResult<()> {
    comment_delete_with(&mut gh(cwd), repo, id, comment_id)
}

pub fn set_state(cwd: &Path, repo: &str, id: &str, change: &StateChange) -> OpResult<IssueDetails> {
    set_state_with(&mut gh(cwd), repo, id, change)
}

pub fn set_assignees(cwd: &Path, repo: &str, id: &str, assignees: &[String]) -> OpResult<IssueDetails> {
    set_assignees_with(&mut gh(cwd), repo, id, assignees)
}

pub fn set_labels(cwd: &Path, repo: &str, id: &str, labels: &[String]) -> OpResult<IssueDetails> {
    set_labels_with(&mut gh(cwd), &SESSION, repo, id, labels)
}

pub fn set_title(cwd: &Path, repo: &str, id: &str, title: &str) -> OpResult<IssueDetails> {
    set_title_with(&mut gh(cwd), repo, id, title)
}

pub fn set_description(cwd: &Path, repo: &str, id: &str, edit: &DescriptionEdit) -> OpResult<IssueDetails> {
    set_description_with(&mut gh(cwd), repo, id, edit)
}

pub fn create(cwd: &Path, repo: &str, input: &IssueCreate) -> OpResult<IssueDetails> {
    create_with(&mut gh(cwd), &SESSION, repo, input)
}

/// The issue's raw reply. The issues endpoints also answer for pull
/// requests, which nothing here reads or writes.
fn fetch_issue(api: &mut Api, repo: &str, number: &str) -> OpResult<Value> {
    let v = api("GET", &format!("repos/{repo}/issues/{number}"), None)?;
    if v.get("pull_request").is_some_and(|pr| !pr.is_null()) {
        return Err(IssueOpError::with_message(IssueOpErrorKind::NotFound, "That number is a pull request, not an issue."));
    }
    Ok(v)
}

pub(crate) fn details_with(api: &mut Api, repo: &str, id: &str) -> OpResult<IssueDetails> {
    let number = issue_number(id)?;
    issue_from(&fetch_issue(api, repo, number)?, repo)
}

/// `cursor` is the page number, from 1.
pub(crate) fn comments_with(api: &mut Api, session: &Mutex<Session>, repo: &str, id: &str, cursor: Option<&str>) -> OpResult<CommentsPage> {
    let number = issue_number(id)?;
    let page = match cursor.map(str::trim).filter(|cursor| !cursor.is_empty()) {
        None => 1,
        Some(cursor) => cursor.parse::<u32>().ok().filter(|page| *page >= 1).ok_or_else(|| IssueOpError::with_message(IssueOpErrorKind::Invalid, "That isn't a page of this issue's comments."))?,
    };
    fetch_issue(api, repo, number)?;
    let access = access(api, session, repo)?;
    let reply = api("GET", &format!("repos/{repo}/issues/{number}/comments?per_page={COMMENTS_PAGE_SIZE}&page={page}"), None)?;
    let items = reply.as_array().ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))?;
    Ok(CommentsPage {
        comments: items.iter().filter_map(|comment| parse_comment(comment, &access)).collect(),
        // A full page may be the last one; the next then comes back empty.
        next_cursor: (items.len() >= COMMENTS_PAGE_SIZE).then(|| (page + 1).to_string()),
    })
}

pub(crate) fn options_with(api: &mut Api, session: &Mutex<Session>, repo: &str, refresh: bool) -> OpResult<IssueOptions> {
    let key = repo.to_ascii_lowercase();
    if refresh {
        let mut session = lock(session);
        session.options.remove(&key);
        session.access.remove(&key);
    } else if let Some(options) = lock(session).options.get(&key) {
        return Ok(options.clone());
    }
    let assignees = all_pages(api, &format!("repos/{repo}/assignees"))?;
    let labels = all_pages(api, &format!("repos/{repo}/labels"))?;
    let options = parse_options(&assignees, &labels);
    lock(session).options.insert(key, options.clone());
    Ok(options)
}

/// The labels as the repository spells them. A name the repository doesn't
/// have is refused: GitHub would quietly create it.
fn repository_labels(api: &mut Api, session: &Mutex<Session>, repo: &str, wanted: &[String]) -> OpResult<Vec<String>> {
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let resolve = |options: &IssueOptions| -> Option<Vec<String>> {
        let mut names: Vec<String> = Vec::new();
        for name in wanted {
            let label = options.labels.iter().find(|label| label.name.eq_ignore_ascii_case(name.trim()))?;
            if !names.contains(&label.name) {
                names.push(label.name.clone());
            }
        }
        Some(names)
    };
    if let Some(names) = resolve(&options_with(api, session, repo, false)?) {
        return Ok(names);
    }
    // Someone may have added the label since the options were read.
    resolve(&options_with(api, session, repo, true)?).ok_or_else(|| IssueOpError::with_message(IssueOpErrorKind::Invalid, "That label doesn't exist in this repository."))
}

fn comment_body(body: &str) -> OpResult<Value> {
    if body.trim().is_empty() {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A comment needs some text."));
    }
    Ok(json!({ "body": body }))
}

/// The comment's path, once it is known to sit on this issue.
fn comment_path(api: &mut Api, repo: &str, number: &str, comment_id: &str) -> OpResult<String> {
    let path = format!("repos/{repo}/issues/comments/{}", comment_number(comment_id)?);
    let v = api("GET", &path, None)?;
    let on_issue = v["issue_url"].as_str().and_then(|url| url.rsplit('/').next()) == Some(number);
    if !on_issue {
        return Err(IssueOpError::with_message(IssueOpErrorKind::NotFound, "That comment isn't on this issue."));
    }
    Ok(path)
}

/// A comment the reader just wrote: GitHub took the write, so they may edit it.
fn written_comment(v: &Value) -> OpResult<IssueComment> {
    let viewer = v["user"]["login"].as_str().unwrap_or("").to_string();
    parse_comment(v, &Access { viewer, moderates: true }).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, GITHUB))
}

pub(crate) fn comment_add_with(api: &mut Api, repo: &str, id: &str, body: &str) -> OpResult<IssueComment> {
    let number = issue_number(id)?;
    let body = comment_body(body)?;
    fetch_issue(api, repo, number)?;
    written_comment(&api("POST", &format!("repos/{repo}/issues/{number}/comments"), Some(&body))?)
}

pub(crate) fn comment_edit_with(api: &mut Api, repo: &str, id: &str, comment_id: &str, body: &str) -> OpResult<IssueComment> {
    let number = issue_number(id)?;
    let body = comment_body(body)?;
    comment_number(comment_id)?;
    fetch_issue(api, repo, number)?;
    let path = comment_path(api, repo, number, comment_id)?;
    written_comment(&api("PATCH", &path, Some(&body))?)
}

pub(crate) fn comment_delete_with(api: &mut Api, repo: &str, id: &str, comment_id: &str) -> OpResult<()> {
    let number = issue_number(id)?;
    comment_number(comment_id)?;
    fetch_issue(api, repo, number)?;
    let path = comment_path(api, repo, number, comment_id)?;
    api("DELETE", &path, None)?;
    Ok(())
}

/// `PATCH` the issue and answer with what GitHub made of it.
fn patch_issue(api: &mut Api, repo: &str, number: &str, body: Value) -> OpResult<IssueDetails> {
    issue_from(&api("PATCH", &format!("repos/{repo}/issues/{number}"), Some(&body))?, repo)
}

pub(crate) fn set_state_with(api: &mut Api, repo: &str, id: &str, change: &StateChange) -> OpResult<IssueDetails> {
    let number = issue_number(id)?;
    let body = match change {
        StateChange::Close { reason: CloseReason::Completed } => json!({ "state": "closed", "state_reason": "completed" }),
        StateChange::Close { reason: CloseReason::NotPlanned } => json!({ "state": "closed", "state_reason": "not_planned" }),
        StateChange::Reopen => json!({ "state": "open", "state_reason": "reopened" }),
        StateChange::WorkflowState { .. } => return Err(IssueOpError::new(IssueOpErrorKind::Unsupported, GITHUB)),
    };
    fetch_issue(api, repo, number)?;
    patch_issue(api, repo, number, body)
}

/// Removes the logins no longer wanted, then adds the new ones. GitHub
/// quietly skips a login that can't be assigned here; the answer shows who is.
pub(crate) fn set_assignees_with(api: &mut Api, repo: &str, id: &str, assignees: &[String]) -> OpResult<IssueDetails> {
    let number = issue_number(id)?;
    let mut wanted: Vec<&str> = Vec::new();
    for login in assignees.iter().map(|login| login.trim().trim_start_matches('@')).filter(|login| !login.is_empty()) {
        if !wanted.iter().any(|seen| seen.eq_ignore_ascii_case(login)) {
            wanted.push(login);
        }
    }
    let mut issue = fetch_issue(api, repo, number)?;
    let current: Vec<String> = issue["assignees"].as_array().map(|all| all.iter().filter_map(|user| user["login"].as_str().map(String::from)).collect()).unwrap_or_default();
    let remove: Vec<&str> = current.iter().map(String::as_str).filter(|login| !wanted.iter().any(|keep| keep.eq_ignore_ascii_case(login))).collect();
    let add: Vec<&str> = wanted.iter().copied().filter(|login| !current.iter().any(|has| has.eq_ignore_ascii_case(login))).collect();
    let path = format!("repos/{repo}/issues/{number}/assignees");
    if !remove.is_empty() {
        issue = api("DELETE", &path, Some(&json!({ "assignees": remove })))?;
    }
    if !add.is_empty() {
        issue = match api("POST", &path, Some(&json!({ "assignees": add }))) {
            Ok(issue) => issue,
            Err(error) => {
                // Don't leave the issue with fewer assignees than it started with.
                if !remove.is_empty() {
                    let _ = api("POST", &path, Some(&json!({ "assignees": remove })));
                }
                return Err(error);
            }
        };
    }
    issue_from(&issue, repo)
}

pub(crate) fn set_labels_with(api: &mut Api, session: &Mutex<Session>, repo: &str, id: &str, labels: &[String]) -> OpResult<IssueDetails> {
    let number = issue_number(id)?;
    let labels = repository_labels(api, session, repo, labels)?;
    fetch_issue(api, repo, number)?;
    patch_issue(api, repo, number, json!({ "labels": labels }))
}

pub(crate) fn set_title_with(api: &mut Api, repo: &str, id: &str, title: &str) -> OpResult<IssueDetails> {
    let number = issue_number(id)?;
    fetch_issue(api, repo, number)?;
    patch_issue(api, repo, number, json!({ "title": title.trim() }))
}

/// GitHub has no conditional write, so the check is against a fresh read
/// just before the write.
pub(crate) fn set_description_with(api: &mut Api, repo: &str, id: &str, edit: &DescriptionEdit) -> OpResult<IssueDetails> {
    let number = issue_number(id)?;
    let issue = fetch_issue(api, repo, number)?;
    let stale = match (edit.expected_description.as_deref(), edit.expected_updated_at.as_deref().filter(|expected| !expected.trim().is_empty())) {
        // Comments move `updated_at` too: only the description itself counts.
        (Some(expected), _) => !same_text(expected, issue["body"].as_str().unwrap_or("")),
        (None, Some(expected)) => !same_time(expected, issue["updated_at"].as_str().unwrap_or("")),
        (None, None) => false,
    };
    if stale {
        return Err(IssueOpError::new(IssueOpErrorKind::Conflict, GITHUB));
    }
    patch_issue(api, repo, number, json!({ "body": edit.description }))
}

pub(crate) fn create_with(api: &mut Api, session: &Mutex<Session>, repo: &str, input: &IssueCreate) -> OpResult<IssueDetails> {
    if input.state_id.is_some() || input.priority.is_some() {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Unsupported, "GitHub issues have no workflow states or priority."));
    }
    let assignees: Vec<&str> = input.assignees.iter().map(|login| login.trim().trim_start_matches('@')).filter(|login| !login.is_empty()).collect();
    if assignees.len() > super::GITHUB_MAX_ASSIGNEES as usize {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A GitHub issue can have at most 10 assignees."));
    }
    let labels = repository_labels(api, session, repo, &input.labels)?;
    let body = json!({ "title": input.title.trim(), "body": input.description, "assignees": assignees, "labels": labels });
    issue_from(&api("POST", &format!("repos/{repo}/issues"), Some(&body))?, repo)
}

#[cfg(test)]
#[path = "github_tests.rs"]
mod tests;
