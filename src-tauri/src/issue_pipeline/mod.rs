//! A session started from an issue, carried through to a merge.
//!
//! Five stages, each visible on the issue page:
//!
//! 1. **Work.** The session the issue page (or the CLI) started, as before.
//! 2. **Pull request.** When the author reports the work done and checked,
//!    TerminalX pushes the branch and opens a pull request that links and
//!    closes the issue; a Linear issue moves to its team's review state.
//! 3. **Review.** A second session that did not write the code reads the pull
//!    request's head commit and answers with a verdict and findings.
//! 4. **Address.** Findings go back to the author; it fixes, TerminalX pushes,
//!    the reviewer reads the new head. At most `max_rounds` reviews.
//! 5. **Merge.** By default the pipeline stops at *Ready to merge*. With the
//!    issue's switch on, TerminalX merges if [`gate::decide`] says every
//!    condition holds for the pull request's current head.
//!
//! The pipeline never acts on what a session seems to mean. The author says
//! "done" in a status block and the reviewer gives its verdict in a review
//! block ([`verdict`]); a reply without one is asked for it once and then left
//! to a person. A verdict counts for one commit only, and the merge is pinned
//! to that commit.
//!
//! [`engine`] is the state machine. It reaches the world through
//! [`engine::Host`], so the same code runs in the app, in a cloud
//! workspace's runtime, and under test. Where it runs is where the
//! workspace is: the desktop backend for a project on this computer
//! ([`desktop`]), the workspace's runtime for a cloud one ([`runtime`]). A
//! cloud workspace never merges by itself: it stops at *Ready to merge*, and
//! a person merges from the issue page with their own `gh`, pinned the same way.

pub mod admission;
pub mod categories;
pub mod cloud_merge;
#[cfg(feature = "desktop")]
pub mod desktop;
pub mod engine;
#[cfg(test)]
mod engine_tests;
pub mod gate;
pub mod host;
pub mod prompts;
pub mod runtime;
pub mod store;
pub mod verdict;

use serde::{Deserialize, Serialize};

use crate::store::index::IssueRef;
pub use gate::StopReason;
pub use verdict::Verdict;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Work,
    PullRequest,
    Review,
    Address,
    Resolve,
    Merge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// A session or TerminalX is doing this stage's work.
    Working,
    /// Nothing to do but wait for GitHub: checks running, a merge queued.
    Waiting,
    /// Reviewed, green and mergeable; a person merges it.
    ReadyToMerge,
    /// Stopped for the reason in `reason`.
    NeedsYou,
    Merged,
    /// A person stopped it.
    Stopped,
}

/// One conversation: a session and the tab in it the pipeline talks to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub session_id: String,
    pub tab_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLink {
    pub number: u64,
    pub url: String,
    /// The branch it merges into.
    pub base: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergedBy {
    /// The switch was on and every condition held.
    Pipeline,
    /// A person pressed Merge on the issue page.
    Person,
    /// Merged somewhere else: GitHub, the PR panel, another tool.
    Elsewhere,
}

/// A merge GitHub took and has not made yet (a merge queue).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub commit: String,
    pub by: MergedBy,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRecord {
    pub commit: String,
    pub at: String,
    pub by: MergedBy,
}

/// One line of the record on the issue page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub at: String,
    pub stage: Stage,
    /// `started`, `workDone`, `pullRequest`, `tracker`, `reviewRequested`,
    /// `verdict`, `findingsPosted`, `findingsSent`, `pushed`, `reminder`,
    /// `waiting`, `readyToMerge`, `needsYou`, `merged`, `stopped`, `resumed`,
    /// `autoMerge`, `note`.
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    pub id: String,
    pub project_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<IssueRef>,
    /// The branch the pull request is opened from: the one the author's
    /// session was on when the pipeline started. Nothing is pushed from any other.
    pub branch: String,
    pub author: SessionRef,
    /// An independent conversation, possibly in the author's session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<SessionRef>,
    /// "Merge automatically when the review is addressed", for this issue.
    /// Never on in a cloud workspace.
    #[serde(default)]
    pub auto_merge: bool,
    #[serde(default)]
    pub resolve_conflicts: bool,
    #[serde(default)]
    pub resolutions: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolver: Option<SessionRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
    /// Run by a cloud workspace's runtime, which stops at *Ready to merge*:
    /// the merge is a person's, made from their computer with their own `gh`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cloud: bool,
    /// The issue's text as the session was started with it, for the
    /// reviewer, where the tracker cannot be read again (a cloud workspace
    /// has no Linear key, and its GitHub token no access to issues).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_body: Option<String>,
    #[serde(default)]
    pub stopped: bool,
    pub stage: Stage,
    pub state: State,
    /// Why it is at *Ready to merge* or *Needs you*.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<StopReason>,
    /// What it is doing or waiting for, in a line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<PrLink>,
    /// Reviews asked for so far.
    #[serde(default)]
    pub round: u32,
    pub max_rounds: u32,
    /// The commit the reviewer was last asked to read, and when.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_requested_at: Option<String>,
    /// The last review whose findings reached the author.
    #[serde(default)]
    pub findings_sent_round: u32,
    /// The reviewer's last verdict, with the findings still open at its commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Verdict>,
    /// Known local-check failures, pinned to commits. Only a passing author
    /// report for the same commit clears one; review and CI cannot certify it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_local_checks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_check: Option<LocalCheck>,
    #[serde(default)]
    pub checking_locally: bool,
    /// The areas of the reviewed diff that called for a security pass.
    #[serde(default)]
    pub security_areas: Vec<String>,
    /// The author's own summary, for the pull request's description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// A session was already asked once for the block its reply lacked.
    #[serde(default)]
    pub reminded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_requested: Option<MergeRequest>,
    /// A commit GitHub refused to merge: it is not asked again of its own accord.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_refused: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged: Option<MergeRecord>,
    #[serde(default)]
    pub events: Vec<Event>,
    pub created: String,
    pub modified: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCheck {
    pub head: String,
    pub command: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchOptions {
    pub auto_merge: bool,
    pub resolve_conflicts: bool,
}

/// The exact inputs of a resolution. A remote writer moving the head invalidates it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub head: String,
    pub remote_head: Option<String>,
    pub base: String,
    pub base_commit: String,
    pub return_stage: Stage,
}

/// The newest lines of the record kept per pipeline.
const EVENT_LIMIT: usize = 200;

impl Pipeline {
    pub fn label(&self) -> &str {
        self.issue.as_ref().map(|issue| issue.identifier.as_str()).unwrap_or(&self.branch)
    }

    pub(crate) fn record(&mut self, at: &str, kind: &str, message: impl Into<String>) -> &mut Event {
        if self.events.len() >= EVENT_LIMIT {
            let over = self.events.len() + 1 - EVENT_LIMIT;
            self.events.drain(..over);
        }
        self.events.push(Event { at: at.to_string(), stage: self.stage, kind: kind.to_string(), message: message.into(), commit: None, url: None, session_id: None });
        self.events.last_mut().expect("just pushed")
    }

    /// The session's part in this pipeline.
    pub fn role_of(&self, session_id: &str, tab_id: &str) -> Option<Role> {
        if self.author.session_id == session_id && self.author.tab_id == tab_id {
            return Some(Role::Author);
        }
        if self.resolver.as_ref().is_some_and(|resolver| resolver.session_id == session_id && resolver.tab_id == tab_id) { return Some(Role::Resolver); }
        self.reviewer.as_ref().filter(|reviewer| reviewer.session_id == session_id && reviewer.tab_id == tab_id).map(|_| Role::Reviewer)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Author,
    Reviewer,
    Resolver,
}

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Self::Author => "author",
            Self::Reviewer => "reviewer",
            Self::Resolver => "conflict resolver",
        }
    }
}
