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
//! A piece that names no model gets one from its kind ([`routing`]): a table
//! of kind to tier and effort, a column per agent, resolved against the
//! models the agent offers. A try that falls short is followed by another on
//! more effort and then on the next model up ([`ladder`]), each a fresh
//! worker, three tries at most; every try is kept on the piece.
//!
//! A worker's `done` is not the piece's: its result is checked first
//! ([`verify`]), by gates that use no model (its report, the files it
//! touched, the state of its branch, the plan's commands) and only then,
//! where a gate cannot settle it, by a verifier session that sees the diff
//! and none of the worker's reasoning. A result that fails a gate is a try
//! that fell short, and takes the next step of the same ladder.
//!
//! Accepted results are brought together by TerminalX too ([`merge`]): each
//! piece's accepted commit is merged into the lead's branch in dependency
//! order, the run's integration check is run after each merge, and a merge
//! that conflicts or fails its check leaves the lead's branch as it was. No
//! model takes part, nothing is pushed, and no other branch is touched.
//!
//! [`engine`] reaches sessions through [`engine::Host`], so the scheduling is
//! the same code in the app and under test.

pub mod brief;
pub mod budget;
pub mod engine;
#[cfg(test)]
mod engine_tests;
pub mod guard;
pub mod host;
pub mod ladder;
pub mod merge;
#[cfg(test)]
mod merge_tests;
pub mod plan;
pub mod routing;
pub mod store;
pub mod verify;

use serde::{Deserialize, Serialize};

use crate::store::settings::Cap;

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
    /// It reached its budget (`pause` says which): no new piece starts until
    /// a person raises it or resumes the run. Workers already in a turn finish it.
    NeedsYou,
    /// Every piece is done and results are being checked.
    Verifying,
    /// Every piece's result is accepted; they are being merged into the
    /// lead's branch, or wait for `runs merge` ([`merge`]).
    Merging,
    /// Every piece is merged into the lead's branch and the checks passed on
    /// the merged result.
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

    /// Started and not over: its pieces follow their workers, and accepted
    /// results can be merged. A failed run is one: a piece sent back to work
    /// brings it back.
    pub fn live(self) -> bool {
        matches!(self, Self::Running | Self::Failed | Self::Merging)
    }

    /// Its pieces follow their workers: a live run, and one paused on its
    /// budget, whose workers already in a turn finish it and are checked.
    pub fn followed(self) -> bool {
        self.live() || self == Self::NeedsYou
    }
}

/// What came of bringing a piece's accepted result into the lead's branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeState {
    /// Its commits are in the lead's branch and the integration check passed there.
    Merged,
    /// It changed no file: there is nothing to bring in.
    NothingToMerge,
    /// Merging it conflicts. The lead's branch was not touched.
    Conflict,
    /// It merged, the integration check failed on the result, and the merge was undone.
    IntegrationFailed,
    /// Left out of a merge on request, so the pieces after it could go on.
    Skipped,
    /// Git could not make the merge for a reason that is not a conflict. The
    /// lead's branch is as it was.
    Failed,
}

/// One file a merge conflicts in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// How many places in it conflict. 0 when the conflict is not in its
    /// lines: one side deleted or renamed it, or it is binary.
    #[serde(default)]
    pub hunks: u32,
    /// The first conflicting place, both sides, as git marks it; cut to fit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    /// The line of the merged file its excerpt starts at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// The pieces already merged that changed this file, by id.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub with: Vec<String>,
    /// The piece the plan gives this file to, when it is not this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

/// The last try at merging a piece's accepted result ([`merge`]). It is
/// about one commit: a piece accepted again at another is not merged by it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceMerge {
    pub state: MergeState,
    /// The accepted commit that was merged, or that the merge was tried with.
    pub commit: String,
    /// Where the lead's branch was before. After a conflict, a failed check
    /// or a skip it is there still.
    pub before: String,
    /// The merge commit, for a piece TerminalX merged: `before..after` is its range.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    /// The lead merged it itself: its commit was found in the lead's branch.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub by_hand: bool,
    /// Where it conflicts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<ConflictFile>,
    /// The integration check as it ran on the merged result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<verify::CommandRun>,
    /// One line on the state, where the state does not say it all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub at: String,
}

impl PieceMerge {
    /// Its commits are in the lead's branch, or it has none to bring.
    pub fn is_in(&self) -> bool {
        matches!(self.state, MergeState::Merged | MergeState::NothingToMerge)
    }
}

/// A merge TerminalX made whose integration check has not ended. Stored
/// before the merge is made, so one cut short (the app stopped) is found and
/// undone by the next `runs merge`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMerge {
    pub piece: String,
    pub before: String,
    /// Absent until the merge commit exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

/// One done-check of a piece, run again on the merged result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalCheck {
    pub piece: String,
    #[serde(flatten)]
    pub command: verify::CommandRun,
}

/// The lead resolving a piece's conflict because a person asked it to
/// (`engine::resolve_in_lead`): the one model call of the merge stage, which
/// the run's budget counts as it counts a worker's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub piece: String,
    /// How the lead's agent is signed in: which budget the call draws on.
    pub login: budget::Login,
    /// What the lead's session had cost when it was asked.
    #[serde(default)]
    pub lead_usd: f64,
    /// What its session has cost since, as of the run's last read.
    #[serde(default)]
    pub usd: f64,
}

/// Where the merge of a run stands ([`merge`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMerge {
    /// The lead's branch: what the pieces are merged into.
    pub into: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<PendingMerge>,
    /// The piece the last pass stopped at: its merge conflicts, or git could not make it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
    /// The commit of the lead's branch the integration check last passed on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_head: Option<String>,
    /// The integration check on the whole merged result, when it failed
    /// there: after a merge the lead made by hand, or a commit of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<verify::CommandRun>,
    /// Every piece's command done-checks, run again once all were merged,
    /// and the commit they ran on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub final_checks: Vec<FinalCheck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_head: Option<String>,
    /// When the last pass ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The lead is resolving a conflict a person gave it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolving: Option<Resolution>,
    /// What earlier such calls cost a lead on an API key.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub resolved_usd: f64,
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

impl RunMerge {
    /// What resolving conflicts in the lead has cost on an API key: counted
    /// in the run's dollar budget with its workers' cost.
    pub fn key_dollars(&self) -> f64 {
        self.resolved_usd + self.resolving.as_ref().filter(|resolving| resolving.login == budget::Login::ApiKey).map_or(0.0, |resolving| resolving.usd)
    }

    /// The call under way is over: what it cost stays counted.
    pub fn end_resolving(&mut self) {
        if let Some(resolving) = self.resolving.take().filter(|resolving| resolving.login == budget::Login::ApiKey) {
            self.resolved_usd += resolving.usd;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PieceState {
    /// No worker yet: it waits for the run to start or for its dependencies.
    Queued,
    /// Its worker is in a turn, or is about to be reminded of its report.
    Running,
    /// Its worker is in a turn but has made no tool call or file change for
    /// the stall time while its agent sits idle and runs no command. The lead
    /// was told. It counts against the worker limits as a running one does.
    Stalled,
    /// Its worker reported `done` and the result is being checked ([`verify`]).
    Verifying,
    /// Its worker reported `done` and the result passed every check.
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    /// Points of a subscription's usage window.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "written")]
    pub points: Option<Cap>,
    /// Dollars, for an agent billed by an API key.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "written")]
    pub dollars: Option<Cap>,
}

/// A budget written into a plan: a number, or No limit as `null` or `"none"`
/// (PRO-335). Left out, the run follows the settings.
fn written<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Cap>, D::Error> {
    Option::<Cap>::deserialize(deserializer).map(|cap| Some(cap.unwrap_or(Cap::NoLimit)))
}

/// What the lead expects a piece to cost, in API-equivalent dollars.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Estimate {
    pub low: f64,
    pub high: f64,
}

/// One thing that proves a piece done. Checked in an order that spends no tokens before
/// it must: commands are run as they are, in the worker's worktree, and a model reads the
/// result only for what no command can show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Check {
    /// A shell command run at the root of the worker's worktree; exit code 0 passes.
    Command { run: String },
    /// What a reviewer who has not seen the worker's reasoning must confirm from the diff.
    Review { text: String },
    /// A claim several reviewers judge separately; it passes when `threshold` of `voters`
    /// agree. Stored with the plan; how many is the verifier's default when absent.
    Vote {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voters: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        threshold: Option<u32>,
    },
}

impl Check {
    /// The command, or the words to confirm.
    pub fn text(&self) -> &str {
        match self {
            Check::Command { run } => run,
            Check::Review { text } | Check::Vote { text, .. } => text,
        }
    }
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

/// How a try ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Its worker reported `done`.
    Done,
    /// Its worker reported `failed`.
    Failed,
    /// Its worker reported `partial`.
    Partial,
    /// Its worker reported `done` and its result failed a check: a gate
    /// ([`verify`]), or a done-check the lead reported. Also a worker that
    /// ended without a report that can be read.
    CheckFailed,
    /// Its worker stopped without finishing: a `blocked` report, no report,
    /// a question for a person, or a deleted session.
    Blocked,
    /// The run was stopped first.
    Stopped,
}

impl Outcome {
    /// The try fell short in a way another try may fix.
    pub fn fell_short(self) -> bool {
        matches!(self, Self::Failed | Self::Partial | Self::CheckFailed)
    }
}

/// One try at a piece: the worker it ran in, on what, at what cost, to what end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Try {
    /// What made it differ from the try before.
    pub step: ladder::Step,
    /// Empty for the agent's own default model.
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<routing::Tier>,
    /// Absent until its worker is started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<SessionRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Absent while it runs, and before it starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    /// The worker's result line, or the failure text the next try is given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// What its worker's session used, at API list prices
    /// (`session_usage`). Absent before any was read, and when no model it
    /// used has a price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// Models whose tokens the cost leaves out: with names here it is partial.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cost_unpriced_models: Vec<String>,
    /// The check of its result: each gate that ran, and the verifier's
    /// tokens when a model read it. Absent before its worker reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<verify::Verification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<String>,
}

impl Try {
    /// A try that has no worker yet.
    pub fn planned(step: ladder::Step, model: &str, effort: Option<&str>, tier: Option<routing::Tier>) -> Self {
        Self { step, model: model.to_string(), effort: effort.map(str::to_owned), tier, worker: None, branch: None, outcome: None, detail: None, cost_usd: None, cost_unpriced_models: Vec::new(), verification: None, started: None, ended: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub id: String,
    pub title: String,
    pub brief: Brief,
    /// The files only this piece may change, as globs relative to the repository's root in
    /// the form `git diff --name-only` prints paths: forward slashes, no leading `./`, a
    /// directory written as `dir/**` ([`plan::owns`] matches a path against them). Empty
    /// for a piece that changes nothing.
    #[serde(default)]
    pub owns: Vec<String>,
    /// Pieces that must be done before this one starts, by id.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// What proves the piece done, in the order written. At least one; a `command` among
    /// them unless `review_only`.
    pub done_checks: Vec<Check>,
    /// No command can prove this piece: its result is checked by review alone.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub review_only: bool,
    /// Why no command can, in the lead's words. Never empty when `review_only`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub review_only_reason: String,
    /// The kind of work, one of [`routing::KINDS`]: what its model and
    /// effort come from when the plan names none. Absent only on a run
    /// stored before kinds were required.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub agent: String,
    /// The model of its current try: the plan's, else the routing table's
    /// for its kind, then whatever escalation moved it to. Empty for the
    /// agent's own default model.
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// The tier its model belongs to, when it belongs to one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<routing::Tier>,
    /// Why its model is not the routing table's: the tier has no installed model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_note: Option<String>,
    /// The plan named no model: the one here is its kind's. A plan made from this run
    /// (`Edit` in the Run view) leaves the model out again, so the kind still decides.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub model_by_kind: bool,
    /// The plan named no effort: the one here is its kind's.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub effort_by_kind: bool,
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
    /// Every try, oldest first: the last is the current one. A try that fell
    /// short is followed by the next step of the ladder ([`ladder`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tries: Vec<Try>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<SessionRef>,
    /// The worker's branch, cut from the lead's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Why its worker has a session but was not sent its brief: the session could not be
    /// made safe to start. The next `runs start` tries that again, with the same session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<String>,
    /// The mode its worker was started in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_mode: Option<String>,
    /// How its worker's agent was signed in when it started: which budget it draws on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<budget::Login>,
    /// The lead (or an approval) asked for it to start, but a limit held it:
    /// it starts by itself when a worker stops and the limit allows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_for: Option<Hold>,
    pub state: PieceState,
    /// One line on the state: the worker's result, or why it is not done.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// What came of merging its accepted result into the lead's branch.
    /// Absent before that was tried.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<PieceMerge>,
}

impl Piece {
    /// The mode its worker runs in: the plan's, else the project's.
    pub fn mode<'a>(&'a self, project_default: &'a str) -> &'a str {
        self.permission_mode.as_deref().unwrap_or(project_default)
    }

    /// A try fell short and the next one waits for its worker.
    pub fn retry_waits(&self) -> bool {
        self.state == PieceState::Queued && self.worker.is_none() && self.tries.len() > 1 && self.tries.last().is_some_and(|last| last.worker.is_none())
    }

    /// The ladder ran out: its last try fell short and no further one is made.
    pub fn gave_up(&self) -> bool {
        self.state == PieceState::Blocked && self.tries.last().and_then(|last| last.outcome).is_some_and(Outcome::fell_short)
    }

    /// Its worker reported `done` and gates 2 to 4 have yet to run on the
    /// result: never run, or cut short when the app stopped.
    pub fn check_waits(&self) -> bool {
        self.state == PieceState::Verifying && self.tries.last().is_some_and(|attempt| attempt.verification.as_ref().is_none_or(|check| check.outcome.is_none() && check.review.is_none()))
    }

    /// The commit its result was accepted as: the one its gates ran on
    /// ([`verify::Facts::commit`]). `None` for a piece that is not done.
    pub fn accepted_commit(&self) -> Option<&str> {
        if self.state != PieceState::Done {
            return None;
        }
        self.tries.last()?.verification.as_ref()?.facts.as_ref()?.commit.as_deref()
    }

    /// Its accepted result is in the lead's branch: merged, or with nothing
    /// to merge, as the commit it is accepted at now.
    pub fn merged(&self) -> bool {
        self.current_merge().is_some_and(PieceMerge::is_in)
    }

    /// What came of merging the result it is accepted with now. `None` for a
    /// piece that is not done, and for a record about another commit: a
    /// piece accepted again since is not what was merged, or what conflicted.
    pub fn current_merge(&self) -> Option<&PieceMerge> {
        self.merge.as_ref().filter(|merge| self.state == PieceState::Done && self.accepted_commit().is_none_or(|commit| commit == merge.commit))
    }

    /// What its tries cost so far, and the models that sum leaves out.
    /// `None` before any cost was read.
    pub fn cost(&self) -> (Option<f64>, Vec<String>) {
        let known: Vec<f64> = self.tries.iter().filter_map(|attempt| attempt.cost_usd).collect();
        let mut unpriced: Vec<String> = Vec::new();
        for model in self.tries.iter().flat_map(|attempt| &attempt.cost_unpriced_models) {
            if !unpriced.contains(model) {
                unpriced.push(model.clone());
            }
        }
        ((!known.is_empty()).then(|| known.iter().sum()), unpriced)
    }
}

/// What keeps a piece the lead asked for from starting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Hold {
    /// The run has as many workers in a turn as it may.
    RunLimit,
    /// The app has as many run workers in a turn as it may, across runs.
    AppLimit,
    /// The run reached its budget and waits for a person.
    Budget,
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
    /// The command run in the lead's checkout after each piece is merged
    /// ([`merge`]); exit code 0 passes. The plan's; the project's own check
    /// command is run when the plan names none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_check: Option<String>,
    /// Where merging its pieces into the lead's branch stands. Absent before
    /// the first `runs merge`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<RunMerge>,
    /// Why it failed, was stopped, or needs the person, or what keeps a merged run from done.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Its worker limit and budget (PRO-280).
    #[serde(default)]
    pub limits: budget::RunLimits,
    /// What it has used, as of its last refresh.
    #[serde(default)]
    pub usage: budget::RunUsage,
    /// Why it is `needsYou`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<budget::Pause>,
    pub created: String,
    pub modified: String,
}

impl Run {
    pub fn piece(&self, id: &str) -> Option<&Piece> {
        self.pieces.iter().find(|piece| piece.id == id)
    }

    /// Its workers in a turn now: what the worker limits count.
    pub fn in_turn(&self) -> usize {
        self.pieces.iter().filter(|piece| piece.worker.is_some() && matches!(piece.state, PieceState::Running | PieceState::Stalled)).count()
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

    /// The pieces in the order they are merged: each after everything it
    /// depends on, and otherwise in the plan's order.
    pub fn merge_order(&self) -> Vec<&Piece> {
        let mut placed: Vec<&Piece> = Vec::new();
        while placed.len() < self.pieces.len() {
            let next = self.pieces.iter().find(|piece| !placed.iter().any(|done| done.id == piece.id) && piece.depends_on.iter().all(|id| self.piece(id).is_none() || placed.iter().any(|done| done.id == *id)));
            // A cycle cannot be stored (`plan::validate`); one read from an old file ends the order in plan order.
            match next.or_else(|| self.pieces.iter().find(|piece| !placed.iter().any(|done| done.id == piece.id))) {
                Some(piece) => placed.push(piece),
                None => break,
            }
        }
        placed
    }

    /// The summed estimate of the pieces that carry one, and how many do not.
    pub fn estimate(&self) -> (Option<Estimate>, usize) {
        let known: Vec<Estimate> = self.pieces.iter().filter_map(|piece| piece.estimate).collect();
        let total = (!known.is_empty()).then(|| Estimate { low: known.iter().map(|e| e.low).sum(), high: known.iter().map(|e| e.high).sum() });
        (total, self.pieces.len() - known.len())
    }
}
