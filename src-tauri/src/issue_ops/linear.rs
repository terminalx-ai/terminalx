//! Linear issue operations, through its GraphQL API with the key in
//! Settings. Every connection is asked for with `first:` so a query stays
//! under Linear's complexity limit of 10,000.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    linear_priorities, CommentsPage, DescriptionEdit, IssueCapabilities, IssueComment, IssueCreate, IssueDetails, IssueOpError, IssueOpErrorKind, IssueOptions, IssueUser, LabelOption, OpResult, Provider, StateChange, WorkflowState,
};

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
        } else if text.contains("validateaccess") || text.contains("item needed to save") {
            // A state, label or assignee picked for the issue that is gone.
            IssueOpErrorKind::Invalid
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

/// The fields `issue_details` reads, and every write answers with.
const DETAILS_FIELDS: &str = "id identifier number title description url createdAt updatedAt priority \
    state { id name type color } labels(first: 50) { nodes { id name color } } \
    assignee { id name displayName avatarUrl } creator { id name displayName avatarUrl } team { id key name }";

const COMMENT_FIELDS: &str = "id body createdAt editedAt url user { id name displayName avatarUrl } botActor { id name avatarUrl }";

/// Comments per page of `issue_comments`.
const COMMENTS_PAGE: usize = 50;

fn user(v: &Value) -> Option<IssueUser> {
    let id = v["id"].as_str()?;
    Some(IssueUser {
        id: id.into(),
        name: v["displayName"].as_str().or_else(|| v["name"].as_str()).unwrap_or("").into(),
        login: None,
        avatar_url: v["avatarUrl"].as_str().map(String::from),
    })
}

/// An issue as `DETAILS_FIELDS` answers it, at `data.issue` or a write's `issue`.
pub fn parse_issue(node: &Value) -> Option<IssueDetails> {
    let issue = crate::issues::parse_linear_issue(node)?;
    Some(IssueDetails {
        issue,
        description: node["description"].as_str().unwrap_or("").into(),
        state_id: node["state"]["id"].as_str().map(String::from),
        state_color: node["state"]["color"].as_str().map(|color| color.trim_start_matches('#').to_string()),
        close_reason: None,
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

// ------------------------------------------------------------------ comments

/// A comment as `COMMENT_FIELDS` answers it. A comment by an integration has
/// a bot for an author, which nobody edits from here.
pub fn parse_comment(node: &Value, viewer_id: Option<&str>) -> Option<IssueComment> {
    let author = user(&node["user"]).or_else(|| {
        let bot = &node["botActor"];
        let name = bot["name"].as_str()?;
        Some(IssueUser { id: bot["id"].as_str().unwrap_or("").into(), name: name.into(), login: None, avatar_url: bot["avatarUrl"].as_str().map(String::from) })
    });
    let mine = viewer_id.is_some() && node["user"]["id"].as_str() == viewer_id;
    Some(IssueComment {
        id: node["id"].as_str()?.into(),
        author,
        body: node["body"].as_str().unwrap_or("").into(),
        created_at: node["createdAt"].as_str().unwrap_or("").into(),
        edited_at: node["editedAt"].as_str().map(String::from),
        url: node["url"].as_str().map(String::from),
        viewer_can_edit: mine,
        viewer_can_delete: mine,
    })
}

/// A comments cursor: the creation time and id of the last comment shown.
/// Comments are ordered by both, so two made in the same millisecond are
/// neither skipped nor shown twice.
fn cursor_of(comment: &IssueComment) -> String {
    format!("{}|{}", comment.created_at, comment.id)
}

fn parse_cursor(cursor: Option<&str>) -> Option<(&str, &str)> {
    let cursor = cursor.map(str::trim).filter(|cursor| !cursor.is_empty())?;
    Some(cursor.split_once('|').unwrap_or((cursor, "")))
}

/// A page as the `comments` query answers it, for the page after `cursor`.
/// Linear hands `last:` back oldest first; they are sorted anyway. The query
/// takes comments from the cursor's own millisecond on, so the ones already
/// shown are dropped here. A full answer means more may follow.
pub fn parse_comments_page(data: &Value, cursor: Option<&str>) -> CommentsPage {
    let viewer = data["viewer"]["id"].as_str();
    let nodes = data["issue"]["comments"]["nodes"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut comments: Vec<IssueComment> = nodes.iter().filter_map(|node| parse_comment(node, viewer)).collect();
    comments.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    if let Some((at, id)) = parse_cursor(cursor) {
        comments.retain(|comment| (comment.created_at.as_str(), comment.id.as_str()) > (at, id));
    }
    let full = nodes.len() > COMMENTS_PAGE;
    let more = comments.len() > COMMENTS_PAGE || (full && comments.len() == COMMENTS_PAGE);
    comments.truncate(COMMENTS_PAGE);
    let next_cursor = if more { comments.last().map(cursor_of) } else { None };
    CommentsPage { comments, next_cursor }
}

/// Oldest first. Linear lists comments newest first and its `before:`
/// cursors walk that order, so a page is the oldest `COMMENTS_PAGE` created
/// from the last comment shown on.
pub fn comments(key: &str, id: &str, cursor: Option<&str>) -> OpResult<CommentsPage> {
    let query = format!(
        "query($id: String!, $last: Int!, $filter: CommentFilter) {{ viewer {{ id }} issue(id: $id) {{ comments(last: $last, filter: $filter) {{ nodes {{ {COMMENT_FIELDS} }} }} }} }}"
    );
    let data = request(key, &query, comments_variables(id, cursor))?;
    if data["issue"].is_null() {
        return Err(IssueOpError::new(IssueOpErrorKind::NotFound, LINEAR));
    }
    Ok(parse_comments_page(&data, cursor))
}

pub fn comments_variables(id: &str, cursor: Option<&str>) -> Value {
    let filter = parse_cursor(cursor).map(|(at, _)| json!({"createdAt": {"gte": at}}));
    // One more than a page, plus room for a comment that shares the cursor's millisecond.
    json!({"id": id, "last": COMMENTS_PAGE + 2, "filter": filter})
}

/// The comment a `commentCreate` or `commentUpdate` answers with. Only its
/// author writes it, so the viewer may edit and delete it.
fn written_comment(payload: &Value) -> OpResult<IssueComment> {
    if payload["success"].as_bool() != Some(true) {
        return Err(IssueOpError::new(IssueOpErrorKind::Other, LINEAR));
    }
    let mut comment = parse_comment(&payload["comment"], None).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, LINEAR))?;
    comment.viewer_can_edit = true;
    comment.viewer_can_delete = true;
    Ok(comment)
}

fn non_empty(body: &str) -> OpResult<&str> {
    if body.trim().is_empty() {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A comment needs some text."));
    }
    Ok(body)
}

pub fn comment_add(key: &str, id: &str, body: &str) -> OpResult<IssueComment> {
    let query = format!("mutation($input: CommentCreateInput!) {{ commentCreate(input: $input) {{ success comment {{ {COMMENT_FIELDS} }} }} }}");
    let data = request(key, &query, json!({"input": {"issueId": id, "body": non_empty(body)?}}))?;
    written_comment(&data["commentCreate"])
}

pub fn comment_edit(key: &str, id: &str, comment_id: &str, body: &str) -> OpResult<IssueComment> {
    let body = non_empty(body)?;
    comment_on_issue(key, id, comment_id)?;
    let query = format!("mutation($id: String!, $input: CommentUpdateInput!) {{ commentUpdate(id: $id, input: $input) {{ success comment {{ {COMMENT_FIELDS} }} }} }}");
    let data = request(key, &query, json!({"id": comment_id, "input": {"body": body}}))?;
    written_comment(&data["commentUpdate"])
}

pub fn comment_delete(key: &str, id: &str, comment_id: &str) -> OpResult<()> {
    comment_on_issue(key, id, comment_id)?;
    let data = request(key, "mutation($id: String!) { commentDelete(id: $id) { success } }", json!({"id": comment_id}))?;
    succeeded(&data["commentDelete"])
}

/// Linear finds a comment by its id alone. One named with another issue is
/// refused as not found, so an edit never lands on the wrong issue.
fn comment_on_issue(key: &str, id: &str, comment_id: &str) -> OpResult<()> {
    let data = request(key, "query($id: String!) { comment(id: $id) { issue { id identifier } } }", json!({"id": comment_id}))?;
    if comment_belongs(&data["comment"], id) {
        Ok(())
    } else {
        Err(IssueOpError::with_message(IssueOpErrorKind::NotFound, "That comment isn't on this issue any more. Refresh the issue, then try again."))
    }
}

/// Whether a `comment { issue { id identifier } }` is on the issue `id` names (its UUID or `ENG-42`).
pub fn comment_belongs(comment: &Value, id: &str) -> bool {
    let issue = &comment["issue"];
    issue["id"].as_str() == Some(id) || issue["identifier"].as_str().is_some_and(|identifier| identifier.eq_ignore_ascii_case(id))
}

fn succeeded(payload: &Value) -> OpResult<()> {
    match payload["success"].as_bool() {
        Some(true) => Ok(()),
        _ => Err(IssueOpError::new(IssueOpErrorKind::Other, LINEAR)),
    }
}

// ------------------------------------------------------------------ options

/// Options per Linear key and team, for the session. `refresh` reads them again.
static OPTIONS: Mutex<Option<HashMap<(u64, String), IssueOptions>>> = Mutex::new(None);

/// The key is held only as a hash, so the cache never keeps a copy of it.
fn options_key(key: &str, team_id: &str) -> (u64, String) {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    (hasher.finish(), team_id.to_string())
}

const TEAM_QUERY: &str = "query($teamId: String!) { \
    team(id: $teamId) { id ancestors { id } states(first: 100) { nodes { id name type color position } } members(first: 250) { nodes { id name displayName avatarUrl active } } } }";

/// The labels a team's issues can take: its own, its parent teams' and the workspace's.
const LABELS_QUERY: &str = "query($teams: [ID!]) { \
    issueLabels(first: 250, filter: { or: [{ team: { id: { in: $teams } } }, { team: { null: true } }] }) { nodes { id name color description isGroup parent { id name } } } }";

/// The teams whose labels `team` (as `TEAM_QUERY` answers it) inherits, itself first.
pub fn label_teams(team: &Value) -> Vec<String> {
    let ancestors = team["ancestors"].as_array().into_iter().flatten().filter_map(|ancestor| ancestor["id"].as_str());
    team["id"].as_str().into_iter().chain(ancestors).map(String::from).collect()
}

/// What `TEAM_QUERY` (`team`) and `LABELS_QUERY` (`issueLabels`) answer: the
/// team's states in its order, its active members by name, and the labels
/// its issues can take, each group before the labels in it.
pub fn parse_options(data: &Value) -> IssueOptions {
    let mut states: Vec<WorkflowState> = data["team"]["states"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|state| {
            Some(WorkflowState {
                id: state["id"].as_str()?.into(),
                name: state["name"].as_str().unwrap_or("").into(),
                state_type: state["type"].as_str().unwrap_or("").into(),
                color: state["color"].as_str().unwrap_or("").trim_start_matches('#').into(),
                position: state["position"].as_f64().unwrap_or(0.0),
            })
        })
        .collect();
    states.sort_by(|a, b| a.position.total_cmp(&b.position));
    let mut members: Vec<IssueUser> = data["team"]["members"]["nodes"].as_array().into_iter().flatten().filter(|member| member["active"].as_bool() != Some(false)).filter_map(user).collect();
    members.sort_by_key(|member| member.name.to_lowercase());
    let mut labels: Vec<LabelOption> = data["issueLabels"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|label| {
            Some(LabelOption {
                id: label["id"].as_str()?.into(),
                name: label["name"].as_str().unwrap_or("").into(),
                color: label["color"].as_str().unwrap_or("").trim_start_matches('#').into(),
                description: label["description"].as_str().filter(|text| !text.is_empty()).map(String::from),
                group: label["parent"]["name"].as_str().map(String::from),
                group_id: label["parent"]["id"].as_str().map(String::from),
                is_group: label["isGroup"].as_bool().unwrap_or(false),
            })
        })
        .collect();
    // A group and its labels sort together under the group's name; groups that share a name stay apart by id.
    labels.sort_by_key(|label| {
        let (group, group_id) = if label.is_group { (&label.name, Some(&label.id)) } else { (label.group.as_ref().unwrap_or(&label.name), label.group_id.as_ref()) };
        (group.to_lowercase(), group_id.cloned(), !label.is_group, label.name.to_lowercase())
    });
    IssueOptions { provider: LINEAR, states, close_reasons: vec![], members, labels, priorities: linear_priorities(), capabilities: IssueCapabilities::of(LINEAR) }
}

/// For an issue's team, or for `team_id` when creating one.
pub fn options(key: &str, id: Option<&str>, team_id: Option<&str>, refresh: bool) -> OpResult<IssueOptions> {
    let team_id = match (team_id.filter(|team| !team.is_empty()), id.filter(|id| !id.is_empty())) {
        (Some(team), _) => team.to_string(),
        (None, Some(id)) => {
            let data = request(key, "query($id: String!) { issue(id: $id) { team { id } } }", json!({"id": id}))?;
            data["issue"]["team"]["id"].as_str().map(String::from).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::NotFound, LINEAR))?
        }
        (None, None) => return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "Choose a Linear team first.")),
    };
    let cache_key = options_key(key, &team_id);
    if !refresh {
        if let Some(cached) = OPTIONS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|cache| cache.get(&cache_key)) {
            return Ok(cached.clone());
        }
    }
    let team = request(key, TEAM_QUERY, json!({"teamId": team_id}))?;
    if team["team"].is_null() {
        return Err(IssueOpError::new(IssueOpErrorKind::NotFound, LINEAR));
    }
    let labels = request(key, LABELS_QUERY, json!({"teams": label_teams(&team["team"])}))?;
    let options = parse_options(&json!({"team": team["team"], "issueLabels": labels["issueLabels"]}));
    OPTIONS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(cache_key, options.clone());
    Ok(options)
}

// ------------------------------------------------------------------ writes

/// One `issueUpdate`, answered with the issue as Linear now has it.
fn update(key: &str, id: &str, input: Value) -> OpResult<IssueDetails> {
    let query = format!("mutation($id: String!, $input: IssueUpdateInput!) {{ issueUpdate(id: $id, input: $input) {{ success issue {{ {DETAILS_FIELDS} }} }} }}");
    let data = request(key, &query, json!({"id": id, "input": input}))?;
    let payload = &data["issueUpdate"];
    match written_issue(payload) {
        // Written, but answered without the issue: read it rather than guess.
        Err(_) if payload["success"].as_bool() == Some(true) => details(key, id),
        result => result,
    }
}

fn written_issue(payload: &Value) -> OpResult<IssueDetails> {
    if payload["success"].as_bool() != Some(true) {
        return Err(IssueOpError::new(IssueOpErrorKind::Other, LINEAR));
    }
    parse_issue(&payload["issue"]).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, LINEAR))
}

pub fn set_state(key: &str, id: &str, change: &StateChange) -> OpResult<IssueDetails> {
    match change {
        StateChange::WorkflowState { state_id } => update(key, id, json!({"stateId": state_id})),
        StateChange::Close { .. } | StateChange::Reopen => Err(IssueOpError::new(IssueOpErrorKind::Unsupported, LINEAR)),
    }
}

/// One user id, or none to unassign.
pub fn set_assignees(key: &str, id: &str, assignees: &[String]) -> OpResult<IssueDetails> {
    update(key, id, json!({"assigneeId": assignee(assignees)?}))
}

fn assignee(assignees: &[String]) -> OpResult<Option<&str>> {
    match assignees {
        [] => Ok(None),
        [one] if !one.trim().is_empty() => Ok(Some(one.as_str())),
        _ => Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A Linear issue has one assignee or none.")),
    }
}

pub fn set_labels(key: &str, id: &str, labels: &[String]) -> OpResult<IssueDetails> {
    update(key, id, json!({"labelIds": labels}))
}

pub fn set_priority(key: &str, id: &str, priority: u8) -> OpResult<IssueDetails> {
    update(key, id, json!({"priority": priority}))
}

pub fn set_title(key: &str, id: &str, title: &str) -> OpResult<IssueDetails> {
    update(key, id, json!({"title": title.trim()}))
}

/// Refused as a conflict when someone else changed the description since
/// the editor started (see [`conflicts`]). Linear has no conditional update,
/// so this reads first; the window between the read and the write is one
/// round trip.
pub fn set_description(key: &str, id: &str, edit: &DescriptionEdit) -> OpResult<IssueDetails> {
    if edit.expected_description.is_some() || edit.expected_updated_at.as_deref().is_some_and(|at| !at.trim().is_empty()) {
        let data = request(key, "query($id: String!) { issue(id: $id) { updatedAt description } }", json!({"id": id}))?;
        if data["issue"].is_null() {
            return Err(IssueOpError::new(IssueOpErrorKind::NotFound, LINEAR));
        }
        if conflicts(&data["issue"], edit) {
            return Err(IssueOpError::new(IssueOpErrorKind::Conflict, LINEAR));
        }
    }
    update(key, id, json!({"description": edit.description}))
}

/// Whether the issue as read now (`updatedAt`, `description`) refuses the
/// edit. With the description the editor started from, only a changed
/// description does: a new comment moves Linear's `updatedAt` too.
pub fn conflicts(current: &Value, edit: &DescriptionEdit) -> bool {
    let normal = |text: &str| text.replace("\r\n", "\n").trim_end().to_string();
    match (edit.expected_description.as_deref(), edit.expected_updated_at.as_deref()) {
        (Some(expected), _) => normal(current["description"].as_str().unwrap_or("")) != normal(expected),
        (None, Some(expected)) if !expected.trim().is_empty() => changed_since(current["updatedAt"].as_str().unwrap_or(""), expected),
        (None, _) => false,
    }
}

/// Whether `current` is a different moment from `expected`. Both are
/// Linear's own ISO times; ones that don't parse are compared as text.
pub fn changed_since(current: &str, expected: &str) -> bool {
    match (chrono::DateTime::parse_from_rfc3339(current), chrono::DateTime::parse_from_rfc3339(expected)) {
        (Ok(current), Ok(expected)) => current != expected,
        _ => current != expected,
    }
}

/// The `issueCreate` input for a new issue.
pub fn create_input(input: &IssueCreate) -> OpResult<Value> {
    let team = input.team_id.as_deref().filter(|team| !team.is_empty()).ok_or_else(|| IssueOpError::with_message(IssueOpErrorKind::Invalid, "Choose a Linear team first."))?;
    let mut fields = json!({"teamId": team, "title": input.title.trim(), "description": input.description});
    if let Some(assignee) = assignee(&input.assignees)? {
        fields["assigneeId"] = json!(assignee);
    }
    if !input.labels.is_empty() {
        fields["labelIds"] = json!(input.labels);
    }
    if let Some(state) = input.state_id.as_deref().filter(|state| !state.is_empty()) {
        fields["stateId"] = json!(state);
    }
    match input.priority {
        Some(priority) if priority > 4 => return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A Linear priority is 0 (none) to 4 (low).")),
        Some(priority) => fields["priority"] = json!(priority),
        None => {}
    }
    Ok(fields)
}

pub fn create(key: &str, input: &IssueCreate) -> OpResult<IssueDetails> {
    let query = format!("mutation($input: IssueCreateInput!) {{ issueCreate(input: $input) {{ success issue {{ {DETAILS_FIELDS} }} }} }}");
    let data = request(key, &query, json!({"input": create_input(input)?}))?;
    written_issue(&data["issueCreate"])
}

#[cfg(test)]
#[path = "linear_tests.rs"]
mod tests;
