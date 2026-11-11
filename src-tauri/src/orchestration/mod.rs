//! An orchestration run: one lead session, a plan of pieces, a worker per piece.
//!
//! The lead writes a plan ([`plan`]): the goal and the pieces it splits into,
//! each with a brief, the files it owns, what it depends on and the check
//! that proves it done. `runs create` validates the plan and stores it as a
//! [`Run`] ([`store`]). Unless the project turned approval off, the run then
//! waits in `awaitingApproval` until a person approves it in the app; no
//! command of the CLI approves one, because the lead runs the CLI.
//!
//! `runs start` starts a worker for every piece whose dependencies are done
//! ([`engine`]): a session of its own, in a worktree of its own branched from
//! the lead's branch, with the piece's model and effort and a brief built
//! from the piece ([`brief`]). Workers start in bypass permission mode unless
//! the project or the plan says otherwise, so the limits a prompt would have
//! caught (no push, no merge, no deploy) are enforced outside the agent's
//! judgment ([`guard`]): deny rules handed to the agent at launch, and a
//! branch with no upstream.
//!
//! [`engine`] reaches sessions through [`engine::Host`], so the scheduling is
//! the same code in the app and under test.

pub mod brief;
pub mod engine;
#[cfg(test)]
mod engine_tests;
pub mod guard;
pub mod host;
pub mod plan;
pub mod store;

use serde::{Deserialize, Serialize};

/// The webview is told a run changed with this event; the payload is the run.
pub const RUN_EVENT: &str = "orchestration_run";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    /// Stored and free to start: approval is off for its project.
    Planned,
    /// Stored; no worker starts until a person approves it.
    AwaitingApproval,
    /// Approved or started: workers are running, or pieces wait on others.
    Running,
    /// Every piece is done and results are being checked.
    Verifying,
    /// Checked results are being merged into the lead's branch.
    Merging,
    /// Every piece is done.
    Done,
    /// A person or the lead stopped it.
    Stopped,
    /// It cannot go on: `reason` says why.
    Failed,
}

impl RunState {
    /// Nothing further starts in a run that has ended.
    pub fn ended(self) -> bool {
        matches!(self, Self::Done | Self::Stopped | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PieceState {
    /// No worker yet: it waits for the run to start or for its dependencies.
    Queued,
    /// Its worker is in a turn, or is about to be reminded of its report.
    Running,
    /// Its worker reported `done`.
    Done,
    /// Its worker stopped without finishing: a `partial` or `blocked` report,
    /// no report, or a question only a person can answer. `note` says which.
    Blocked,
    /// Its worker reported `failed`, or could not be started.
    Failed,
    /// The run was stopped while it was not done.
    Stopped,
}

/// One conversation: a session and the tab in it that does the work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub session_id: String,
    /// The lead's tab is known only when the command ran inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

/// What a run may use. Recorded with the run and shown with the plan.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// Points of a subscription's usage window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub points: Option<f64>,
    /// Dollars, for an agent billed by an API key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dollars: Option<f64>,
}

/// What the lead expects a piece to cost, in API-equivalent dollars.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub low: f64,
    pub high: f64,
}

/// What a worker is told, field by field ([`brief::render`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    /// What is true when the piece is done.
    pub goal: String,
    /// Why the run needs it: what depends on it, what it unblocks.
    #[serde(default)]
    pub why: String,
    /// What the piece covers, in the lead's words.
    #[serde(default)]
    pub scope: String,
    /// What it must leave alone.
    #[serde(default)]
    pub out_of_scope: String,
    /// Facts the lead already established, so the worker does not re-derive them.
    #[serde(default)]
    pub known: Vec<String>,
    /// Files to read before anything else.
    #[serde(default)]
    pub read_first: Vec<String>,
    /// Limits of this piece, beyond the ones every worker has.
    #[serde(default)]
    pub limits: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub id: String,
    pub title: String,
    pub brief: Brief,
    /// The files or areas only this piece may change: paths relative to the
    /// repository, a directory for everything in it, `*` and `**` as in a
    /// glob. Empty for a piece that changes nothing.
    #[serde(default)]
    pub owns: Vec<String>,
    /// Pieces that must be done before this one starts, by id.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// The command or condition that proves the piece done.
    pub done_check: String,
    /// The kind of work, as the lead named it (`search`, `code`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub agent: String,
    /// Empty for the agent's own default model.
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// The plan's own choice; the project's setting when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// It reads text from outside the repository (issues, web pages, logs).
    #[serde(default)]
    pub reads_untrusted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate: Option<Estimate>,
    /// How many workers were started for it.
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<SessionRef>,
    /// The worker's branch, cut from the lead's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The mode its worker was started in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_mode: Option<String>,
    pub state: PieceState,
    /// One line on the state: the worker's result, or why it is not done.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Piece {
    /// The mode its worker runs in: the plan's, else the project's.
    pub fn mode<'a>(&'a self, project_default: &'a str) -> &'a str {
        self.permission_mode.as_deref().unwrap_or(project_default)
    }
}

/// Who approved a run, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub lead: SessionRef,
    /// The project the lead works in; workers are sessions of it.
    pub project_path: String,
    pub goal: String,
    pub state: RunState,
    #[serde(default)]
    pub budget: Budget,
    pub pieces: Vec<Piece>,
    /// The mode a piece that names none runs in, as the project had it set
    /// when the run was created.
    pub worker_mode: String,
    /// A person changed the plan after the lead wrote it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan_edited: bool,
    /// A person approved the plan. Absent while it waits, and for a run of a
    /// project that asks for no approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    /// Why it failed or was stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub created: String,
    pub modified: String,
}

impl Run {
    pub fn piece(&self, id: &str) -> Option<&Piece> {
        self.pieces.iter().find(|piece| piece.id == id)
    }

    /// Pieces with no worker yet whose dependencies are all done, in plan
    /// order. One whose worker could not be started is ready again.
    pub fn ready(&self) -> Vec<&Piece> {
        self.pieces
            .iter()
            .filter(|piece| piece.worker.is_none() && matches!(piece.state, PieceState::Queued | PieceState::Failed))
            .filter(|piece| piece.depends_on.iter().all(|id| self.piece(id).is_some_and(|dependency| dependency.state == PieceState::Done)))
            .collect()
    }

    /// The summed estimate of the pieces that carry one, and how many do not.
    pub fn estimate(&self) -> (Option<Estimate>, usize) {
        let known: Vec<Estimate> = self.pieces.iter().filter_map(|piece| piece.estimate).collect();
        let total = (!known.is_empty()).then(|| Estimate { low: known.iter().map(|e| e.low).sum(), high: known.iter().map(|e| e.high).sum() });
        (total, self.pieces.len() - known.len())
    }
}
