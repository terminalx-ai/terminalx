//! Linear issue operations, through its GraphQL API with the key in
//! Settings. Every connection is asked for with `first:` so a query stays
//! under Linear's complexity limit of 10,000.

use std::time::Duration;

use serde_json::{json, Value};

use super::{CommentsPage, DescriptionEdit, IssueCapabilities, IssueComment, IssueCreate, IssueDetails, IssueOpError, IssueOpErrorKind, IssueOptions, IssueUser, OpResult, Provider, StateChange};

const LINEAR_API: &str = "https://api.linear.app/graphql";
const LINEAR: Provider = Provider::Linear;

/// One GraphQL request. A failure is classified from the status and the
/// reply's errors, and the reply is dropped.
pub(crate) fn request(key: &str, query: &str, variables: Value) -> OpResult<Value> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
    let resp = agent.post(LINEAR_API).set("Authorization", key).set("Content-Type", "application/json").send_json(json!({"query": query, "variables": variables}));
    let (status, body) = match resp {
        Ok(r) => (r.status(), r.into_json::<Value>().unwrap_or(Value::Null)),
        Err(ureq::Error::Status(code, r)) => (code, r.into_json::<Value>().unwrap_or(Value::Null)),
        Err(ureq::Error::Transport(_)) => return Err(IssueOpError::new(IssueOpErrorKind::Network, LINEAR)),
    };
    if let Some(kind) = classify(status, &body) {
        return Err(IssueOpError::new(kind, LINEAR));
    }
    Ok(body["data"].clone())
}

/// The kind of a failed Linear request, or `None` when it succeeded.
pub fn classify(status: u16, body: &Value) -> Option<IssueOpErrorKind> {
    let errors = body["errors"].as_array().filter(|errors| !errors.is_empty());
    if (200..300).contains(&status) && errors.is_none() && !body["data"].is_null() {
        return None;
    }
    let mut kinds = errors.into_iter().flatten().map(|error| {
        let code = error["extensions"]["code"].as_str().unwrap_or("").to_ascii_uppercase();
        let text = format!("{} {}", error["message"].as_str().unwrap_or(""), error["extensions"]["userPresentableMessage"].as_str().unwrap_or("")).to_ascii_lowercase();
        if code == "AUTHENTICATION_ERROR" || text.contains("authentication required") || text.contains("not authenticated") {
            IssueOpErrorKind::NotSignedIn
        } else if code == "RATELIMITED" || text.contains("rate limit") {
            IssueOpErrorKind::RateLimited
        } else if text.contains("scope") || text.contains("read-only") || text.contains("read only") {
            IssueOpErrorKind::MissingScope
        } else if code == "FORBIDDEN" || text.contains("forbidden") || text.contains("permission") {
            IssueOpErrorKind::Forbidden
        } else if text.contains("not found") || text.contains("could not find") {
            IssueOpErrorKind::NotFound
        } else if code == "CONFLICT" || text.contains("conflict") {
            IssueOpErrorKind::Conflict
        } else if code.contains("INPUT") || code == "GRAPHQL_VALIDATION_FAILED" {
            IssueOpErrorKind::Invalid
        } else {
            IssueOpErrorKind::Other
        }
    });
    let from_errors = kinds.next();
    Some(match status {
        401 => IssueOpErrorKind::NotSignedIn,
        429 => IssueOpErrorKind::RateLimited,
        403 => from_errors.filter(|kind| *kind == IssueOpErrorKind::MissingScope).unwrap_or(IssueOpErrorKind::Forbidden),
        500..=599 => from_errors.unwrap_or(IssueOpErrorKind::Network),
        _ => from_errors.unwrap_or(IssueOpErrorKind::Other),
    })
}

/// The fields `issue_details` reads, comments for the agent included.
const DETAILS_FIELDS: &str = "id identifier number title description url createdAt updatedAt priority \
    state { id name type color } labels(first: 50) { nodes { id name color } } \
    assignee { id name displayName avatarUrl } creator { id name displayName avatarUrl } team { id key name } \
    comments(first: 20) { nodes { body createdAt user { displayName name } } }";

fn user(v: &Value) -> Option<IssueUser> {
    let id = v["id"].as_str()?;
    Some(IssueUser {
        id: id.into(),
        name: v["displayName"].as_str().or_else(|| v["name"].as_str()).unwrap_or("").into(),
        login: None,
        avatar_url: v["avatarUrl"].as_str().map(String::from),
    })
}

/// An issue as `query { issue(id:) { DETAILS_FIELDS } }` answers it, at `data.issue`.
pub fn parse_issue(node: &Value) -> Option<IssueDetails> {
    let mut issue = crate::issues::parse_linear_issue(node)?;
    crate::issues::append_linear_comments(&mut issue, node);
    Some(IssueDetails {
        issue,
        description: node["description"].as_str().unwrap_or("").into(),
        state_id: node["state"]["id"].as_str().map(String::from),
        state_color: node["state"]["color"].as_str().map(|color| color.trim_start_matches('#').to_string()),
        close_reason: None,
        assignees: user(&node["assignee"]).into_iter().collect(),
        priority: node["priority"].as_u64().map(|priority| priority.min(4) as u8),
        author: user(&node["creator"]),
        created_at: node["createdAt"].as_str().unwrap_or("").into(),
        repo: None,
        capabilities: IssueCapabilities::of(LINEAR),
    })
}

/// `id` is the issue's UUID or its identifier (`ENG-42`); Linear takes either.
pub fn details(key: &str, id: &str) -> OpResult<IssueDetails> {
    let query = format!("query($id: String!) {{ issue(id: $id) {{ {DETAILS_FIELDS} }} }}");
    let data = request(key, &query, json!({"id": id}))?;
    parse_issue(&data["issue"]).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::NotFound, LINEAR))
}

pub fn comments(_key: &str, _id: &str, _cursor: Option<&str>) -> OpResult<CommentsPage> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn options(_key: &str, _id: Option<&str>, _team_id: Option<&str>, _refresh: bool) -> OpResult<IssueOptions> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn comment_add(_key: &str, _id: &str, _body: &str) -> OpResult<IssueComment> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn comment_edit(_key: &str, _id: &str, _comment_id: &str, _body: &str) -> OpResult<IssueComment> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn comment_delete(_key: &str, _id: &str, _comment_id: &str) -> OpResult<()> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn set_state(_key: &str, _id: &str, _change: &StateChange) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn set_assignees(_key: &str, _id: &str, _assignees: &[String]) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn set_labels(_key: &str, _id: &str, _labels: &[String]) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn set_priority(_key: &str, _id: &str, _priority: u8) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn set_title(_key: &str, _id: &str, _title: &str) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn set_description(_key: &str, _id: &str, _edit: &DescriptionEdit) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(LINEAR))
}

pub fn create(_key: &str, _input: &IssueCreate) -> OpResult<IssueDetails> {
    Err(IssueOpError::not_implemented(LINEAR))
}
