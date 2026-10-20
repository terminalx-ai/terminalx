//! Managing an issue from TerminalX: reading it whole, its comments and what
//! its pickers offer, and changing it. One shape for GitHub and Linear.
//!
//! The provider differences live here, not in the UI:
//!
//! * **Linear** has the team's workflow states (any number, each with a
//!   type), one assignee or none, and a priority from 0 (none) to 4 (low).
//!   Assignees and labels are named by id. Credentials: the API key in
//!   Settings.
//! * **GitHub** has open and closed, a close reason (`completed`,
//!   `not_planned`) and reopening, up to [`GITHUB_MAX_ASSIGNEES`] assignees,
//!   and no priority. Assignees are named by login and labels by name.
//!   Credentials: the reader's own `gh` login, through `gh api` REST.
//!
//! [`IssueCapabilities`] says which of these an issue has, so the UI only
//! offers what the provider supports. Every write answers with the issue as
//! re-read from the provider ([`IssueDetails`]), or the comment for comment
//! writes, so the UI never guesses the result.
//!
//! Failures come back as an [`IssueOpError`]: a [`IssueOpErrorKind`] and a
//! fixed message for it. The message never carries a token, a key or the
//! provider's raw reply.
//!
//! On the wire field names are camelCase and enum values snake_case. The
//! TypeScript mirror is `src/lib/issueOps.ts`.

pub mod github;
pub mod linear;
pub mod templates;
pub mod viewer;

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::issues::Issue;

/// GitHub's own cap on assignees per issue.
pub const GITHUB_MAX_ASSIGNEES: u32 = 10;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Github,
    Linear,
}

pub use crate::issues::IssueUser;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    Completed,
    NotPlanned,
}

/// What the UI may offer for an issue. Fixed per provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueCapabilities {
    /// Linear's team workflow states, against GitHub's open and closed.
    pub workflow_states: bool,
    /// GitHub closes with a [`CloseReason`] and reopens.
    pub close_reasons: bool,
    pub priority: bool,
    pub multi_assignee: bool,
    pub max_assignees: u32,
}

impl IssueCapabilities {
    pub fn of(provider: Provider) -> Self {
        match provider {
            Provider::Github => IssueCapabilities { workflow_states: false, close_reasons: true, priority: false, multi_assignee: true, max_assignees: GITHUB_MAX_ASSIGNEES },
            Provider::Linear => IssueCapabilities { workflow_states: true, close_reasons: false, priority: true, multi_assignee: false, max_assignees: 1 },
        }
    }
}

/// An issue read whole. It carries every field of the list's [`Issue`] (so
/// callers of the older `issue_details` keep working) plus the rest.
///
/// `description` is the description alone. On Linear neither it nor `body`
/// carries comments; they are read through `issue_comments`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetails {
    #[serde(flatten)]
    pub issue: Issue,
    /// Markdown, without any comments.
    pub description: String,
    /// The Linear workflow state's id; GitHub has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_id: Option<String>,
    /// Hex without the hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_color: Option<String>,
    /// Why a closed GitHub issue was closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_reason: Option<CloseReason>,
    /// Linear's 0 (none) to 4 (low); GitHub has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<IssueUser>,
    pub created_at: String,
    /// `owner/repo` for GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub capabilities: IssueCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<IssueUser>,
    /// Markdown.
    pub body: String,
    pub created_at: String,
    /// Set once the comment was edited after it was posted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub viewer_can_edit: bool,
    pub viewer_can_delete: bool,
}

/// Comments oldest first. `next_cursor` is passed back to `issue_comments`
/// for the next page; `None` means this is the last one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommentsPage {
    pub comments: Vec<IssueComment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A Linear workflow state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub id: String,
    pub name: String,
    /// Linear's own type: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`.
    #[serde(rename = "type")]
    pub state_type: String,
    /// Hex without the hash.
    pub color: String,
    /// The team's order for the state; lower first.
    pub position: f64,
}

/// A label an issue can be given.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LabelOption {
    /// What `issue_set_labels` takes: the id on Linear, the name on GitHub.
    pub id: String,
    pub name: String,
    /// Hex without the hash.
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The Linear label group this one sits in, by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// That group's id: groups can share a name, and an issue takes one label per group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// A Linear label group itself, which issues are not given.
    #[serde(default)]
    pub is_group: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PriorityOption {
    /// 0 none, 1 urgent, 2 high, 3 medium, 4 low.
    pub value: u8,
    pub label: String,
}

/// What the pickers offer for one GitHub repository or Linear team. Lists a
/// provider does not have are empty.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueOptions {
    pub provider: Provider,
    /// Linear: the team's workflow states.
    pub states: Vec<WorkflowState>,
    /// GitHub: the reasons an issue can be closed with.
    pub close_reasons: Vec<CloseReason>,
    /// Linear: the team's members. GitHub: the repository's assignable users.
    pub members: Vec<IssueUser>,
    pub labels: Vec<LabelOption>,
    /// Linear only.
    pub priorities: Vec<PriorityOption>,
    pub capabilities: IssueCapabilities,
}

/// Linear's priorities, in its own order and words.
pub fn linear_priorities() -> Vec<PriorityOption> {
    ["No priority", "Urgent", "High", "Medium", "Low"].iter().enumerate().map(|(value, label)| PriorityOption { value: value as u8, label: (*label).into() }).collect()
}

/// A change of state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StateChange {
    /// Linear: move to one of the team's workflow states.
    WorkflowState { state_id: String },
    /// GitHub: close with a reason.
    Close { reason: CloseReason },
    /// GitHub: open a closed issue again.
    Reopen,
}

/// A description edit. `expected_updated_at` is the `updatedAt` the editor
/// started from, and `expected_description` the description it started
/// from. When the description changed since, the write is refused with
/// [`IssueOpErrorKind::Conflict`] instead of overwriting someone else's edit.
///
/// A comment or any other change also moves `updatedAt`, so with
/// `expected_description` only a changed description is a conflict;
/// without it, any change since `expected_updated_at` is.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DescriptionEdit {
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_description: Option<String>,
}

/// A new issue: in the project's GitHub repository, or in a Linear team.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueCreate {
    /// Linear: the team it is created in. Required there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    pub title: String,
    pub description: String,
    /// Ids as `issue_set_assignees` takes them.
    pub assignees: Vec<String>,
    /// Ids as `issue_set_labels` takes them.
    pub labels: Vec<String>,
    /// Linear: the workflow state to start in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_id: Option<String>,
    /// Linear: 0 to 4.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
}

// ------------------------------------------------------------------ errors

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IssueOpErrorKind {
    /// No `gh` login, or no (or a revoked) Linear key.
    NotSignedIn,
    /// The `gh` token lacks `repo`, or the Linear key is read-only.
    MissingScope,
    Forbidden,
    NotFound,
    /// The issue changed since the edit started.
    Conflict,
    RateLimited,
    Network,
    /// The provider has no such thing, like a priority on GitHub.
    Unsupported,
    /// The input is not something the provider takes, like an 11th GitHub assignee.
    Invalid,
    /// Not built yet.
    NotImplemented,
    /// Anything the provider said that fits none of the above.
    Other,
}

/// What a failed issue operation answers. `message` is fixed per kind and
/// provider, or a fixed sentence of this module's own: never a token, a key
/// or the provider's reply.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueOpError {
    pub kind: IssueOpErrorKind,
    pub message: String,
}

pub type OpResult<T> = Result<T, IssueOpError>;

impl IssueOpError {
    pub fn new(kind: IssueOpErrorKind, provider: Provider) -> Self {
        IssueOpError { kind, message: message(kind, provider).into() }
    }

    /// A kind with a sentence of its own. `&'static` so no reply or secret can reach it.
    pub fn with_message(kind: IssueOpErrorKind, message: &'static str) -> Self {
        IssueOpError { kind, message: message.into() }
    }
}

impl std::fmt::Display for IssueOpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for IssueOpError {}

/// The fixed message for a kind.
pub fn message(kind: IssueOpErrorKind, provider: Provider) -> &'static str {
    use IssueOpErrorKind::*;
    match (kind, provider) {
        (NotSignedIn, Provider::Github) => "The GitHub CLI (gh) is not signed in. Run gh auth login, then try again.",
        (NotSignedIn, Provider::Linear) => "Linear is not connected, or its API key was revoked. Add a key in Settings → Integrations.",
        (MissingScope, Provider::Github) => "Your gh login can't change issues here. Run gh auth refresh -s repo, then try again.",
        (MissingScope, Provider::Linear) => "Your Linear API key is read-only. Create one that can write in Linear's settings and add it in Settings → Integrations.",
        (Forbidden, Provider::Github) => "Your GitHub account doesn't have permission to do that in this repository.",
        (Forbidden, Provider::Linear) => "Your Linear account doesn't have permission to do that in this team.",
        (NotFound, Provider::Github) => "GitHub couldn't find that issue, or your account can't see it.",
        (NotFound, Provider::Linear) => "Linear couldn't find that issue, or your account can't see it.",
        (Conflict, _) => "Someone else changed this issue since you started editing. Refresh it, then make your change again.",
        (RateLimited, Provider::Github) => "GitHub is limiting requests right now. Wait a minute, then try again.",
        (RateLimited, Provider::Linear) => "Linear is limiting requests right now. Wait a minute, then try again.",
        (Network, Provider::Github) => "Couldn't reach GitHub. Check your connection, then try again.",
        (Network, Provider::Linear) => "Couldn't reach Linear. Check your connection, then try again.",
        (Unsupported, Provider::Github) => "GitHub issues don't have that.",
        (Unsupported, Provider::Linear) => "Linear issues don't have that.",
        (Invalid, _) => "That change isn't one the issue can take.",
        (NotImplemented, _) => "TerminalX can't do this yet. Open the issue in your browser to make this change.",
        (Other, Provider::Github) => "GitHub couldn't do that. Try again, or open the issue in your browser.",
        (Other, Provider::Linear) => "Linear couldn't do that. Try again, or open the issue in your browser.",
    }
}

// ------------------------------------------------------------------ operations

/// Where an operation runs: the GitHub repository of a project, or Linear
/// through the key in Settings.
pub enum Target {
    Github { cwd: std::path::PathBuf, repo: String },
    Linear { key: String },
}

impl Target {
    pub fn resolve(project_path: &Path, provider: Provider) -> OpResult<Target> {
        match provider {
            Provider::Github => {
                let repo = crate::issues::github_repo(project_path)
                    .ok_or_else(|| IssueOpError::with_message(IssueOpErrorKind::NotFound, "This project has no GitHub remote. Add one named origin to manage its issues."))?;
                Ok(Target::Github { cwd: crate::issues::gh_dir(project_path), repo })
            }
            Provider::Linear => {
                let key = crate::store::settings::load().linear_api_key.filter(|key| !key.trim().is_empty()).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::NotSignedIn, Provider::Linear))?;
                Ok(Target::Linear { key })
            }
        }
    }
}

pub fn details(target: &Target, id: &str) -> OpResult<IssueDetails> {
    match target {
        Target::Github { cwd, repo } => github::details(cwd, repo, id),
        Target::Linear { key } => linear::details(key, id),
    }
}

pub fn comments(target: &Target, id: &str, cursor: Option<&str>) -> OpResult<CommentsPage> {
    match target {
        Target::Github { cwd, repo } => github::comments(cwd, repo, id, cursor),
        Target::Linear { key } => linear::comments(key, id, cursor),
    }
}

/// For an issue (`id`), or for a new one: GitHub needs neither, Linear the team.
pub fn options(target: &Target, id: Option<&str>, team_id: Option<&str>, refresh: bool) -> OpResult<IssueOptions> {
    match target {
        Target::Github { cwd, repo } => github::options(cwd, repo, refresh),
        Target::Linear { key } => linear::options(key, id, team_id, refresh),
    }
}

pub fn comment_add(target: &Target, id: &str, body: &str) -> OpResult<IssueComment> {
    match target {
        Target::Github { cwd, repo } => github::comment_add(cwd, repo, id, body),
        Target::Linear { key } => linear::comment_add(key, id, body),
    }
}

pub fn comment_edit(target: &Target, id: &str, comment_id: &str, body: &str) -> OpResult<IssueComment> {
    match target {
        Target::Github { cwd, repo } => github::comment_edit(cwd, repo, id, comment_id, body),
        Target::Linear { key } => linear::comment_edit(key, id, comment_id, body),
    }
}

pub fn comment_delete(target: &Target, id: &str, comment_id: &str) -> OpResult<()> {
    match target {
        Target::Github { cwd, repo } => github::comment_delete(cwd, repo, id, comment_id),
        Target::Linear { key } => linear::comment_delete(key, id, comment_id),
    }
}

pub fn set_state(target: &Target, id: &str, change: &StateChange) -> OpResult<IssueDetails> {
    match (target, change) {
        (Target::Github { .. }, StateChange::WorkflowState { .. }) => Err(IssueOpError::with_message(IssueOpErrorKind::Unsupported, "GitHub issues are open or closed; they have no workflow states.")),
        (Target::Linear { .. }, StateChange::Close { .. } | StateChange::Reopen) => Err(IssueOpError::with_message(IssueOpErrorKind::Unsupported, "Linear issues move between their team's workflow states.")),
        (Target::Github { cwd, repo }, change) => github::set_state(cwd, repo, id, change),
        (Target::Linear { key }, change) => linear::set_state(key, id, change),
    }
}

pub fn set_assignees(target: &Target, id: &str, assignees: &[String]) -> OpResult<IssueDetails> {
    let provider = target.provider();
    let max = IssueCapabilities::of(provider).max_assignees as usize;
    if assignees.len() > max {
        return Err(IssueOpError::with_message(
            IssueOpErrorKind::Invalid,
            if provider == Provider::Github { "A GitHub issue can have at most 10 assignees." } else { "A Linear issue has one assignee or none." },
        ));
    }
    match target {
        Target::Github { cwd, repo } => github::set_assignees(cwd, repo, id, assignees),
        Target::Linear { key } => linear::set_assignees(key, id, assignees),
    }
}

pub fn set_labels(target: &Target, id: &str, labels: &[String]) -> OpResult<IssueDetails> {
    match target {
        Target::Github { cwd, repo } => github::set_labels(cwd, repo, id, labels),
        Target::Linear { key } => linear::set_labels(key, id, labels),
    }
}

pub fn set_priority(target: &Target, id: &str, priority: u8) -> OpResult<IssueDetails> {
    match target {
        Target::Github { .. } => Err(IssueOpError::with_message(IssueOpErrorKind::Unsupported, "GitHub issues have no priority.")),
        Target::Linear { .. } if priority > 4 => Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "A Linear priority is 0 (none) to 4 (low).")),
        Target::Linear { key } => linear::set_priority(key, id, priority),
    }
}

pub fn set_title(target: &Target, id: &str, title: &str) -> OpResult<IssueDetails> {
    if title.trim().is_empty() {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "An issue needs a title."));
    }
    match target {
        Target::Github { cwd, repo } => github::set_title(cwd, repo, id, title),
        Target::Linear { key } => linear::set_title(key, id, title),
    }
}

pub fn set_description(target: &Target, id: &str, edit: &DescriptionEdit) -> OpResult<IssueDetails> {
    match target {
        Target::Github { cwd, repo } => github::set_description(cwd, repo, id, edit),
        Target::Linear { key } => linear::set_description(key, id, edit),
    }
}

pub fn create(target: &Target, input: &IssueCreate) -> OpResult<IssueDetails> {
    if input.title.trim().is_empty() {
        return Err(IssueOpError::with_message(IssueOpErrorKind::Invalid, "An issue needs a title."));
    }
    match target {
        Target::Github { cwd, repo } => github::create(cwd, repo, input),
        Target::Linear { key } => linear::create(key, input),
    }
}

impl Target {
    pub fn provider(&self) -> Provider {
        match self {
            Target::Github { .. } => Provider::Github,
            Target::Linear { .. } => Provider::Linear,
        }
    }
}

#[cfg(test)]
mod tests;
