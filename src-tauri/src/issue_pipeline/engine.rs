//! The pipeline's state machine.
//!
//! Three things move it: a session's turn ending, a poll of the pull request
//! while it waits, and a person on the issue page. Each runs as one step under
//! the pipeline's own lock: load, do the stage's work, commit, announce.
//!
//! A step is slow where the world is slow (a push, a `gh` call), so the two
//! switches a reader can flip are not part of it. They are written straight to
//! the store, and a step reads them again at the last moment before anything
//! it cannot take back.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};

use crate::github::{PinnedMerge, PrSnapshot};
use crate::store::index::{IssueRef, SessionEntry};
use crate::store::projects::IssuePipelineSettings;

use super::gate::{self, same_commit, Facts, Gate, StopReason, Wait};
use super::verdict::{self, AuthorReport, LocalChecks, ReviewError, SecurityPass, Verdict};
use super::{categories, prompts, store, MergeRecord, MergeRequest, MergedBy, Pipeline, PrLink, Role, SessionRef, Stage, State};

/// How long checks may stay unfinished before a person is asked to look.
pub const CHECKS_WAIT_MINUTES: u32 = 60;

/// How long a head must have been on the pull request before anything is
/// concluded from its checks. CI lists a commit's checks a moment after the
/// push; until it has, "no check is failing" and "there are no checks" say
/// nothing about the commit.
pub const HEAD_SETTLE_SECONDS: i64 = 90;

/// How many times a pull request is read again while it still shows the head
/// from before a push.
const HEAD_CATCH_UP_TRIES: u32 = 5;

/// How often the pull requests pipelines wait on are looked at.
pub const POLL_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

/// The longest issue text kept with a pipeline for its reviewer.
const ISSUE_BODY_LIMIT: usize = 16 * 1024;

/// A checkout as the pipeline needs to know it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub head: String,
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    /// Paths with uncommitted changes, untracked files included.
    pub dirty: Vec<String>,
    /// Commits the branch has that its base does not.
    pub ahead_of_base: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Diff {
    pub paths: Vec<String>,
    pub patch: String,
}

/// Everything the pipeline does to the world, and everything it reads from it.
pub trait Host: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
    /// A cloud workspace's runtime: it carries a pipeline to *Ready to merge*
    /// and no further, since its GitHub token is the workspace's and not the
    /// reader's own.
    fn cloud(&self) -> bool {
        false
    }
    fn session(&self, session_id: &str) -> Result<SessionEntry>;
    /// The project's settings. An error when they cannot be read: defaults
    /// must not stand in for a project that keeps the merge for a person.
    fn settings(&self, project_path: &str) -> Result<IssuePipelineSettings>;
    /// Give GitHub a moment to catch up with a push.
    fn pause(&self) {}
    /// Type a prompt into a session's tab.
    fn send(&self, to: &SessionRef, prompt: &str) -> Result<()>;
    /// A tab's last finished turn: when it ended and its last reply. For a
    /// runtime that restarted between a turn's end and the step it started.
    fn last_reply(&self, _session: &SessionRef) -> Option<(DateTime<Utc>, String)> {
        None
    }
    /// A new session in the author's checkout, for the review.
    fn open_reviewer(&self, pipeline: &Pipeline, author: &SessionEntry) -> Result<SessionRef>;
    fn workspace(&self, cwd: &Path) -> Result<Workspace>;
    /// What this checkout calls the branch a pull request merges into.
    fn base_ref(&self, cwd: &Path, base_branch: &str) -> String;
    /// What `head` changes relative to where it left `base`.
    fn diff(&self, cwd: &Path, base: &str, head: &str) -> Result<Diff>;
    fn push(&self, cwd: &Path) -> Result<()>;
    /// The open pull request whose head is `branch`, if there is one.
    fn open_pull_request(&self, cwd: &Path, branch: &str) -> Result<Option<PrSnapshot>>;
    /// Open a pull request for the current branch; its number.
    fn create_pull_request(&self, cwd: &Path, title: &str, body: &str) -> Result<u64>;
    fn pull_request(&self, cwd: &Path, number: u64) -> Result<PrSnapshot>;
    fn edit_pull_request_body(&self, cwd: &Path, number: u64, body: &str) -> Result<()>;
    /// Comment on the pull request; the comment's URL.
    fn comment(&self, cwd: &Path, number: u64, body: &str) -> Result<String>;
    /// Merge only if the head is still `commit`.
    fn merge(&self, cwd: &Path, number: u64, method: &str, commit: &str) -> Result<PinnedMerge>;
    /// The issue's text, for the reviewer. `None` when the tracker cannot be read.
    fn issue_body(&self, project_path: &str, issue: &IssueRef) -> Option<String>;
    /// Move the issue to its tracker's review state. `Ok(None)` when the
    /// tracker has nothing to move (GitHub links the pull request by itself).
    fn move_to_review(&self, issue: &IssueRef) -> Result<Option<String>>;
    /// The pipeline was written; tell whoever shows it.
    fn changed(&self, pipeline: &Pipeline);
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Steps running now, anywhere in this process.
static STEPS: AtomicUsize = AtomicUsize::new(0);

struct Running;

impl Running {
    fn start() -> Self {
        STEPS.fetch_add(1, Ordering::Relaxed);
        Running
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        STEPS.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Pipelines that are doing something with nobody's turn to show for it: a
/// stage's step in flight (a push, a pull request being opened, a review
/// being started), or a pull request whose checks are being waited for. A
/// cloud workspace counts them as running turns, so it is not put to sleep
/// halfway (`cloud_activity`). A look at a pipeline parked on a person is not
/// counted: it would keep an idle workspace awake. A wait counts for
/// [`CHECKS_WAIT_MINUTES`] from when it began and no longer, whether or not
/// GitHub could be read meanwhile; the poller then stops it for a person.
pub fn holding() -> usize {
    holding_at(Utc::now())
}

pub(crate) fn holding_at(now: DateTime<Utc>) -> usize {
    let waits = store::waits().into_iter().filter(|since| (now - *since).num_minutes() < i64::from(CHECKS_WAIT_MINUTES)).count();
    STEPS.load(Ordering::Relaxed) + waits
}

fn step_lock(id: &str) -> Arc<Mutex<()>> {
    static LOCKS: Mutex<BTreeMap<String, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());
    LOCKS.lock().unwrap_or_else(|error| error.into_inner()).entry(id.to_string()).or_default().clone()
}

/// Who is asking for the merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Merger {
    /// The pipeline itself: only with the switch on.
    Pipeline,
    /// A person pressed Merge on the issue page.
    Person,
}

/// What a step that failed does about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnError {
    /// A stage could not do its work: stop and say which part.
    NeedsYou,
    /// A look at GitHub failed: nothing changed, and the caller hears why.
    Report,
}

struct Step<'a> {
    host: &'a dyn Host,
    p: Pipeline,
    /// Where git and gh run: the author's checkout, or the project once that is gone.
    cwd: PathBuf,
    author: Option<SessionEntry>,
    settings: IssuePipelineSettings,
    /// Why `settings` is only the defaults, when the project's could not be read.
    settings_error: Option<String>,
    /// The part of the stage in hand, for the reason if it fails.
    doing: &'static str,
}

/// Run one step on a pipeline. A stopped pipeline takes no step unless a
/// person's own action asks for one.
fn run(host: &dyn Host, id: &str, even_if_stopped: bool, on_error: OnError, action: impl FnOnce(&mut Step<'_>) -> Result<()>) -> Result<Pipeline> {
    // A stage's work, not a look at GitHub (`OnError::Report`), which the poller takes every few minutes.
    let _running = (on_error == OnError::NeedsYou).then(Running::start);
    let lock = step_lock(id);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    let pipeline = store::get(id)?;
    if pipeline.stopped && !even_if_stopped {
        return Ok(pipeline);
    }
    let author = host.session(&pipeline.author.session_id).ok();
    let cwd = author.as_ref().map(|session| PathBuf::from(&session.cwd)).filter(|cwd| cwd.is_dir()).unwrap_or_else(|| PathBuf::from(&pipeline.project_path));
    let (settings, settings_error) = match host.settings(&pipeline.project_path) {
        Ok(settings) => (settings, None),
        Err(error) => (IssuePipelineSettings::default(), Some(format!("{error:#}"))),
    };
    let mut step = Step { host, p: pipeline, cwd, author, settings, settings_error, doing: "This step" };
    if let Err(error) = action(&mut step) {
        match on_error {
            OnError::Report => return Err(error),
            OnError::NeedsYou => {
                let reason = StopReason::Failed { step: step.doing.to_string(), message: format!("{error:#}") };
                step.needs_you(reason);
            }
        }
    }
    step.save()?;
    Ok(step.p)
}

impl Step<'_> {
    fn stamp(&self) -> String {
        stamp(self.host.now())
    }

    fn record(&mut self, kind: &str, message: impl Into<String>) -> &mut super::Event {
        let at = self.stamp();
        self.p.record(&at, kind, message)
    }

    /// Write the working copy and announce it, if it differs from what is stored.
    fn save(&mut self) -> Result<()> {
        if store::commit(&mut self.p)? {
            self.host.changed(&self.p);
        }
        Ok(())
    }

    /// Where the pipeline stands now. A change of state or of reason is a
    /// line in the record; the same state reached again is not.
    fn settle(&mut self, state: State, reason: Option<StopReason>, note: impl Into<String>) {
        let note = note.into();
        if self.p.state != state || self.p.reason != reason {
            let kind = match state {
                State::Working => "note",
                State::Waiting => "waiting",
                State::ReadyToMerge => "readyToMerge",
                State::NeedsYou => "needsYou",
                State::Merged => "merged",
                State::Stopped => "stopped",
            };
            // A stage's own lines say what it started; only a stop is news here.
            if state != State::Working {
                self.record(kind, note.clone());
            }
        }
        self.p.state = state;
        self.p.reason = reason;
        self.p.note = Some(note);
    }

    fn needs_you(&mut self, reason: StopReason) {
        let note = reason.describe();
        self.settle(State::NeedsYou, Some(reason), note);
    }

    fn enter(&mut self, stage: Stage, note: impl Into<String>) {
        self.p.stage = stage;
        self.p.reminded = false;
        self.settle(State::Working, None, note);
    }

    /// The switches as stored this instant, not as this step loaded them.
    fn switches(&self) -> (bool, bool) {
        store::get(&self.p.id).map(|stored| (stored.auto_merge, stored.stopped)).unwrap_or((self.p.auto_merge, self.p.stopped))
    }

    /// Whether a person stopped the pipeline while this step was running.
    fn halted(&mut self) -> bool {
        let (_, stopped) = self.switches();
        if stopped {
            self.settle(State::Stopped, None, "Stopped. Nothing further happens until it is resumed.");
        }
        stopped
    }

    fn author_session(&mut self) -> Option<SessionEntry> {
        if self.author.is_none() {
            self.needs_you(StopReason::SessionStopped { role: Role::Author.label().into(), detail: "The session was deleted, so there is no workspace left to work in.".into() });
        }
        self.author.clone()
    }

    /// The author's checkout, with nothing uncommitted in it. `None` after
    /// the pipeline was stopped for the reason it is not.
    fn clean_workspace(&mut self) -> Result<Option<Workspace>> {
        self.doing = "Reading the workspace";
        if self.author_session().is_none() {
            return Ok(None);
        }
        let workspace = self.host.workspace(&self.cwd)?;
        // A session can be moved to another checkout, and a checkout to another
        // branch. Whatever is there now, only the pipeline's own branch is
        // ever pushed: never the project's default branch because a session
        // happens to sit on it.
        if workspace.branch.as_deref() != Some(self.p.branch.as_str()) {
            self.needs_you(StopReason::WorkspaceMoved { expected: self.p.branch.clone(), found: workspace.branch.clone().unwrap_or_else(|| "no branch".into()) });
            return Ok(None);
        }
        if !workspace.dirty.is_empty() {
            self.needs_you(StopReason::UncommittedChanges { files: workspace.dirty.clone() });
            return Ok(None);
        }
        Ok(Some(workspace))
    }

    fn seconds_since(&self, at: &str) -> Option<i64> {
        DateTime::parse_from_rfc3339(at).ok().map(|at| (self.host.now() - at.with_timezone(&Utc)).num_seconds())
    }

    // ---- a session's turn ended ------------------------------------------

    fn author_turn(&mut self, message: &str) -> Result<()> {
        let report = verdict::author_report(message);
        // A pull request that could not be opened (uncommitted files, a
        // refused push) is tried again when the author next says it is done:
        // that is usually the turn in which it put the cause right.
        if self.p.stage == Stage::PullRequest && self.p.state == State::NeedsYou {
            return match report {
                AuthorReport::Done { checks, .. } if checks != LocalChecks::Failed => self.open_pull_request(),
                _ => Ok(()),
            };
        }
        // Otherwise the author is listened to while its stage is open, a stop
        // for one of its own reasons included: a person may have answered it since.
        if !matches!(self.p.stage, Stage::Work | Stage::Address) || !matches!(self.p.state, State::Working | State::NeedsYou) {
            return Ok(());
        }
        match report {
            AuthorReport::Done { checks: LocalChecks::Failed, .. } => self.needs_you(StopReason::LocalChecksFailed),
            AuthorReport::Done { checks, summary } => {
                if self.p.stage == Stage::Work {
                    if summary.is_some() {
                        self.p.summary = summary;
                    }
                    let checked = if checks == LocalChecks::None { "the project has no checks to run" } else { "its checks pass" };
                    let author = self.p.author.session_id.clone();
                    self.record("workDone", format!("The author session reports the work done; {checked}.")).session_id = Some(author);
                    self.open_pull_request()?;
                } else {
                    let author = self.p.author.session_id.clone();
                    self.record("workDone", "The author session reports the findings addressed.").session_id = Some(author);
                    self.push_and_review()?;
                }
            }
            AuthorReport::NotDone { reason } => {
                self.needs_you(StopReason::AuthorNotDone { detail: reason.unwrap_or_else(|| "It did not say what it needs.".into()) });
            }
            AuthorReport::Missing => {
                let otherwise = StopReason::AuthorNotDone { detail: "It ended its turn without saying whether the work is done.".into() };
                self.remind(Role::Author, prompts::author_reminder(), otherwise)?;
            }
        }
        Ok(())
    }

    /// Ask a session once more for the block its reply lacked; a second
    /// reply without it is left to a person.
    fn remind(&mut self, role: Role, prompt: String, otherwise: StopReason) -> Result<()> {
        if self.p.reminded {
            self.needs_you(otherwise);
            return Ok(());
        }
        if self.halted() {
            return Ok(());
        }
        let to = match role {
            Role::Author => self.p.author.clone(),
            Role::Reviewer => self.p.reviewer.clone().context("the pipeline has no reviewer session")?,
        };
        self.doing = "Asking the session again";
        self.p.reminded = true;
        self.settle(State::Working, None, format!("Asked the {} session again for its report.", role.label()));
        // Written first: the answer may come before this step ends.
        self.save()?;
        self.host.send(&to, &prompt)?;
        self.record("reminder", format!("Asked the {} session again: {}", role.label(), otherwise.describe())).session_id = Some(to.session_id);
        Ok(())
    }

    fn reviewer_turn(&mut self, message: &str) -> Result<()> {
        if self.p.stage != Stage::Review || self.p.state != State::Working {
            return Ok(());
        }
        let commit = self.p.review_commit.clone().context("no review was asked for")?;
        let no_verdict = |problem: String| (prompts::reviewer_reminder(&commit, &problem), StopReason::NoVerdict { detail: capitalized(&problem) });
        let read = verdict::review(message, self.p.round, &self.stamp());
        let unusable = match &read {
            Err(ReviewError::Missing) => Some(no_verdict("its reply did not end with the review block.".into())),
            Err(ReviewError::Unreadable(why)) => Some(no_verdict(format!("{why}."))),
            Ok(verdict) if !same_commit(&verdict.commit, &commit) => Some(no_verdict(format!("its verdict is for commit {} and the pull request is at {}.", verdict.commit, short(&commit)))),
            Ok(verdict) if !self.p.security_areas.is_empty() && verdict.security_pass == SecurityPass::NotNeeded => Some((
                prompts::reviewer_reminder(&commit, &format!("the change touches {} and it reports no security pass.", list(&self.p.security_areas))),
                StopReason::SecurityPassMissing { areas: self.p.security_areas.clone() },
            )),
            Ok(_) => None,
        };
        if let Some((prompt, otherwise)) = unusable {
            return self.remind(Role::Reviewer, prompt, otherwise);
        }
        let mut verdict = read.expect("an unreadable verdict returned above");

        // A verdict is about the commit the checkout was at. If the reviewer
        // moved it, or left edits behind, the next push would carry its work
        // out under the author's name.
        self.doing = "Reading the workspace";
        let workspace = self.host.workspace(&self.cwd)?;
        if !same_commit(&workspace.head, &commit) {
            self.needs_you(StopReason::ReviewerChangedWorkspace { detail: format!("the checkout is at {} and the commit it reviewed is {}.", short(&workspace.head), short(&commit)) });
            return Ok(());
        }
        if !workspace.dirty.is_empty() {
            self.needs_you(StopReason::ReviewerChangedWorkspace { detail: format!("it left uncommitted changes in {}.", list(&workspace.dirty)) });
            return Ok(());
        }

        verdict.commit = commit.clone();
        let blocker = gate::verdict_blocker(&verdict);
        let reviewer = self.p.reviewer.as_ref().map(|reviewer| reviewer.session_id.clone());
        let outcome = verdict_line(&verdict, self.p.max_rounds);
        let event = self.record("verdict", outcome);
        event.commit = Some(commit.clone());
        event.session_id = reviewer;
        self.p.reminded = false;
        self.p.verdict = Some(verdict.clone());
        self.save()?;

        if let Some(link) = self.p.pr.clone() {
            match self.host.comment(&self.cwd, link.number, &verdict::review_comment(&verdict, self.p.max_rounds, blocker.is_none())) {
                Ok(url) => self.record("findingsPosted", "Posted the review on the pull request.").url = Some(if url.is_empty() { link.url } else { url }),
                Err(error) => {
                    self.record("note", format!("The review could not be posted on the pull request: {error:#}"));
                }
            }
        }

        match blocker {
            None => {
                // The review is done whatever GitHub answers next: a look at
                // the pull request that fails is retried from the merge stage,
                // not by reviewing again.
                self.enter(Stage::Merge, "Checking the pull request.");
                self.evaluate(Merger::Pipeline)
            }
            Some(_) if self.p.round < self.p.max_rounds => self.send_findings(&verdict),
            Some(_) => {
                let blocking: Vec<_> = verdict.blocking().collect();
                self.needs_you(StopReason::RoundLimit { rounds: self.p.round, count: blocking.len(), worst: blocking.iter().map(|finding| finding.severity).max() });
                Ok(())
            }
        }
    }

    // ---- the stages ------------------------------------------------------

    fn open_pull_request(&mut self) -> Result<()> {
        self.enter(Stage::PullRequest, "Opening the pull request.");
        let Some(workspace) = self.clean_workspace()? else {
            return Ok(());
        };
        if workspace.ahead_of_base == 0 {
            self.needs_you(StopReason::NothingToReview);
            return Ok(());
        }
        let branch = workspace.branch.context("The workspace is not on a branch.")?;
        if self.halted() {
            return Ok(());
        }
        self.doing = "Pushing the branch";
        self.host.push(&self.cwd)?;
        self.doing = "Opening the pull request";
        let issue = self.p.issue.clone();
        let pr = match self.host.open_pull_request(&self.cwd, &branch)? {
            Some(existing) => {
                // Opened by the session, or by an earlier try: it still has to
                // link the issue so that merging closes it.
                if !prompts::links_issue(&existing.body, &issue) {
                    let body = format!("{}\n\n{}", existing.body.trim_end(), prompts::closing_line(&issue));
                    if let Err(error) = self.host.edit_pull_request_body(&self.cwd, existing.number, body.trim_start()) {
                        self.record("note", format!("Pull request #{} could not be linked to {}: {error:#}", existing.number, issue.identifier));
                    }
                }
                self.record("pullRequest", format!("Using pull request #{}, already open for this branch.", existing.number)).url = Some(existing.url.clone());
                existing
            }
            None => {
                let body = prompts::pull_request_body(&issue, self.p.summary.as_deref());
                let number = self.host.create_pull_request(&self.cwd, &issue.title, &body)?;
                let pr = self.host.pull_request(&self.cwd, number)?;
                self.record("pullRequest", format!("Opened pull request #{number}. Merging it closes {}.", issue.identifier)).url = Some(pr.url.clone());
                pr
            }
        };
        self.p.pr = Some(PrLink { number: pr.number, url: pr.url.clone(), base: pr.base.clone() });
        // The pull request exists whatever happens to the rest of this step.
        self.save()?;
        self.move_issue_to_review();
        self.request_review(false)
    }

    fn move_issue_to_review(&mut self) {
        if self.p.events.iter().any(|event| event.kind == "tracker") {
            return;
        }
        let issue = self.p.issue.clone();
        match self.host.move_to_review(&issue) {
            Ok(Some(message)) => self.record("tracker", message).url = Some(issue.url),
            Ok(None) => {}
            Err(error) => {
                self.record("tracker", format!("{} could not be moved to review: {error:#}", issue.identifier));
            }
        }
    }

    /// Have the reviewer read the pull request's head. `by_person` is a
    /// review someone asked for by hand, which the round limit does not refuse.
    fn request_review(&mut self, by_person: bool) -> Result<()> {
        let link = self.p.pr.clone().context("There is no pull request to review yet.")?;
        self.doing = "Reading the pull request";
        let mut pr = self.host.pull_request(&self.cwd, link.number)?;
        if pr.state != "OPEN" {
            // Merged or closed while nobody was looking: the gate says which.
            return self.evaluate_snapshot(pr, Merger::Pipeline);
        }
        let Some(workspace) = self.clean_workspace()? else {
            return Ok(());
        };
        let Some(author) = self.author.clone() else {
            return Ok(());
        };
        // A push is on the remote before the pull request shows it.
        let mut tries = 0;
        while pr.state == "OPEN" && !same_commit(&workspace.head, &pr.head_sha) && tries < HEAD_CATCH_UP_TRIES {
            self.host.pause();
            pr = self.host.pull_request(&self.cwd, link.number)?;
            tries += 1;
        }
        self.doing = "Starting the review";
        if !same_commit(&workspace.head, &pr.head_sha) {
            bail!("The workspace is at {} and the pull request is at {}. Push or pull so they match, then review again.", short(&workspace.head), short(&pr.head_sha));
        }
        if self.p.round >= self.p.max_rounds {
            if !by_person {
                let blocking: Vec<_> = self.p.verdict.iter().flat_map(|verdict| verdict.blocking()).collect();
                let reason = StopReason::RoundLimit { rounds: self.p.round, count: blocking.len(), worst: blocking.iter().map(|finding| finding.severity).max() };
                self.needs_you(reason);
                return Ok(());
            }
            self.p.max_rounds = self.p.round + 1;
        }
        let base = self.host.base_ref(&self.cwd, &pr.base);
        let diff = self.host.diff(&self.cwd, &base, &pr.head_sha)?;
        self.p.security_areas = categories::security_areas(&diff.paths, &diff.patch);
        if self.halted() {
            return Ok(());
        }

        // The same reviewer for every round, so it can say what became of its
        // own findings. One that was deleted is replaced.
        let existing = self.p.reviewer.clone().filter(|reviewer| self.host.session(&reviewer.session_id).is_ok_and(|session| session.tab(&reviewer.tab_id).is_some()));
        let first = existing.is_none();
        let reviewer = match existing {
            Some(reviewer) => reviewer,
            None => {
                let reviewer = self.host.open_reviewer(&self.p, &author)?;
                if reviewer.session_id == self.p.author.session_id {
                    bail!("The reviewer must be a different session from the author.");
                }
                reviewer
            }
        };
        let previous = self.p.review_commit.clone().filter(|_| !first);
        let issue_body = if first { self.p.issue_body.clone().or_else(|| self.host.issue_body(&self.p.project_path, &self.p.issue)) } else { None };
        let request = prompts::ReviewRequest { issue: &self.p.issue, issue_body: issue_body.as_deref(), pr_number: pr.number, pr_url: &pr.url, commit: &pr.head_sha, base: &base, security_areas: &self.p.security_areas };
        let prompt = if first { prompts::review(&request) } else { prompts::review_again(&request, previous.as_deref()) };

        let before = (self.p.round, self.p.review_commit.clone(), self.p.review_requested_at.clone());
        self.p.reviewer = Some(reviewer.clone());
        self.p.round += 1;
        self.p.review_commit = Some(pr.head_sha.clone());
        self.p.review_requested_at = Some(self.stamp());
        self.p.waiting_since = None;
        self.p.merge_requested = None;
        self.p.merge_refused = None;
        let note = format!("Review {} of {}: the reviewer session is reading {}.", self.p.round, self.p.max_rounds, short(&pr.head_sha));
        self.enter(Stage::Review, note.clone());
        // Written before the prompt goes out: the reviewer's turn ending must
        // find its pipeline waiting for it.
        self.save()?;
        if let Err(error) = self.host.send(&reviewer, &prompt) {
            (self.p.round, self.p.review_commit, self.p.review_requested_at) = before;
            return Err(error);
        }
        let security = if self.p.security_areas.is_empty() { String::new() } else { format!(" A security pass is required: the change touches {}.", list(&self.p.security_areas)) };
        let event = self.record("reviewRequested", format!("{note}{security}"));
        event.commit = Some(pr.head_sha);
        event.session_id = Some(reviewer.session_id);
        Ok(())
    }

    fn send_findings(&mut self, verdict: &Verdict) -> Result<()> {
        if self.author_session().is_none() || self.halted() {
            return Ok(());
        }
        self.doing = "Sending the findings to the author";
        let pr_url = self.p.pr.as_ref().map(|link| link.url.clone()).unwrap_or_default();
        let blocking = verdict.blocking().count();
        let note = format!("The author session is addressing the findings of review {}.", verdict.round);
        self.enter(Stage::Address, note);
        self.save()?;
        let author = self.p.author.clone();
        self.host.send(&author, &prompts::address(&verdict.findings, &verdict.commit, &pr_url, verdict.round, self.p.max_rounds))?;
        self.p.findings_sent_round = verdict.round;
        let open = verdict.findings.len();
        self.record("findingsSent", format!("Sent {open} finding{} to the author session ({blocking} of medium severity or higher).", if open == 1 { "" } else { "s" })).session_id = Some(author.session_id);
        Ok(())
    }

    fn push_and_review(&mut self) -> Result<()> {
        let Some(workspace) = self.clean_workspace()? else {
            return Ok(());
        };
        if self.p.verdict.as_ref().is_some_and(|verdict| same_commit(&verdict.commit, &workspace.head)) {
            self.needs_you(StopReason::NoChangesMade);
            return Ok(());
        }
        if self.halted() {
            return Ok(());
        }
        self.doing = "Pushing the branch";
        self.host.push(&self.cwd)?;
        let pushed = format!("Pushed {}.", short(&workspace.head));
        self.record("pushed", pushed).commit = Some(workspace.head);
        self.request_review(false)
    }

    // ---- the merge gate --------------------------------------------------

    fn evaluate(&mut self, merger: Merger) -> Result<()> {
        let link = self.p.pr.clone().context("There is no pull request yet.")?;
        self.doing = "Reading the pull request";
        let pr = self.host.pull_request(&self.cwd, link.number)?;
        self.evaluate_snapshot(pr, merger)
    }

    fn evaluate_snapshot(&mut self, pr: PrSnapshot, merger: Merger) -> Result<()> {
        let link = PrLink { number: pr.number, url: pr.url.clone(), base: pr.base.clone() };
        let verdict = self.p.verdict.clone();
        let reviewed_head = verdict.as_ref().is_some_and(|verdict| same_commit(&verdict.commit, &pr.head_sha));
        // What the diff touches is only asked of a head that was reviewed: for
        // any other, the gate stops before it could matter.
        let protected = if pr.state == "OPEN" && reviewed_head {
            self.doing = "Reading the change";
            let base = self.host.base_ref(&self.cwd, &pr.base);
            let diff = self.host.diff(&self.cwd, &base, &pr.head_sha)?;
            categories::protected_hits(&self.settings.protected, &diff.paths, verdict.as_ref())
        } else {
            Vec::new()
        };
        // A person pressing Merge is the person the three holds wait for;
        // everything that makes a merge wrong still applies to them.
        let by_person = merger == Merger::Person;
        let (auto_merge, _) = self.switches();
        let decision = gate::decide(&Facts {
            auto_merge: by_person || auto_merge,
            require_person: !by_person && self.settings.require_person,
            cloud: !by_person && self.p.cloud,
            verdict: verdict.as_ref(),
            pr: &pr,
            security_areas: &self.p.security_areas,
            protected: if by_person { &[] } else { &protected },
            ignored_checks: &self.settings.ignored_checks,
        });
        self.p.stage = Stage::Merge;
        self.p.pr = Some(link.clone());
        if !matches!(decision, Gate::Wait(_)) {
            self.p.waiting_since = None;
        }
        // The reviewed head only just reached GitHub: its checks may not be
        // listed yet, and an empty list would read as nothing failing.
        let passes = matches!(decision, Gate::Merge { .. } | Gate::ReadyToMerge(_));
        let age = self.p.review_requested_at.as_deref().and_then(|at| self.seconds_since(at));
        if passes && age.is_some_and(|age| age < HEAD_SETTLE_SECONDS) {
            self.settle(State::Waiting, None, format!("Giving checks a moment to be reported on {}.", short(&pr.head_sha)));
            return Ok(());
        }
        // A merge GitHub took for this head and has not made yet (a merge
        // queue) is waited for: not asked for again, and not reported as
        // "ready, automatic merge is off" when the switch was turned off
        // after GitHub already had it. A person may still press Merge.
        let accepted = self.p.merge_requested.clone().filter(|request| merger == Merger::Pipeline && passes && pr.state == "OPEN" && same_commit(&request.commit, &pr.head_sha));
        if let Some(request) = accepted {
            if self.seconds_since(&request.at).is_some_and(|waited| waited >= i64::from(CHECKS_WAIT_MINUTES) * 60) {
                self.needs_you(StopReason::Failed {
                    step: "Merging the pull request".into(),
                    message: format!("GitHub accepted the merge of {} and has not completed it after {CHECKS_WAIT_MINUTES} minutes. Look at the pull request's merge queue.", short(&request.commit)),
                });
            } else {
                self.settle(State::Waiting, None, "GitHub accepted the merge and has not completed it yet.");
            }
            return Ok(());
        }
        match decision {
            Gate::Merged => {
                let by = self.p.merge_requested.as_ref().map(|request| request.by).unwrap_or(MergedBy::Elsewhere);
                self.merged(&link, &pr.head_sha, by);
            }
            Gate::Merge { commit } => {
                // A project whose settings cannot be read may be one that keeps
                // the merge for a person: nothing is merged on a guess.
                if let (Merger::Pipeline, Some(error)) = (merger, self.settings_error.clone()) {
                    self.needs_you(StopReason::Failed { step: "Reading the project's settings".into(), message: format!("{error} Nothing is merged automatically until they can be read.") });
                    return Ok(());
                }
                self.merge(&link, &commit, merger)?;
            }
            Gate::Wait(wait) => {
                let since = self.p.waiting_since.clone().unwrap_or_else(|| self.stamp());
                let waited = DateTime::parse_from_rfc3339(&since).map(|since| (self.host.now() - since.with_timezone(&Utc)).num_minutes()).unwrap_or(0);
                self.p.waiting_since = Some(since);
                match wait {
                    Wait::Checks(names) if waited >= i64::from(CHECKS_WAIT_MINUTES) => self.needs_you(StopReason::ChecksStalled { names, minutes: CHECKS_WAIT_MINUTES }),
                    Wait::Checks(names) => self.settle(State::Waiting, None, format!("Waiting for checks on {}: {}.", short(&pr.head_sha), list(&names))),
                    Wait::Mergeability if waited >= i64::from(CHECKS_WAIT_MINUTES) => {
                        self.needs_you(StopReason::Failed { step: "Reading the pull request".into(), message: "GitHub has not said whether the branch can be merged.".into() });
                    }
                    Wait::Mergeability => self.settle(State::Waiting, None, "Waiting for GitHub to work out whether the branch merges."),
                }
            }
            Gate::ReadyToMerge(reason) => {
                let note = reason.describe();
                self.settle(State::ReadyToMerge, Some(reason), note);
            }
            Gate::NeedsYou(reason) => self.needs_you(reason),
        }
        Ok(())
    }

    fn merge(&mut self, link: &PrLink, commit: &str, merger: Merger) -> Result<()> {
        // Read again, here: a switch turned off a moment ago, while this step
        // was reading GitHub, still stops the merge.
        let (auto_merge, stopped) = self.switches();
        if stopped {
            self.settle(State::Stopped, None, "Stopped. Nothing further happens until it is resumed.");
            return Ok(());
        }
        if merger == Merger::Pipeline && !auto_merge {
            self.settle(State::ReadyToMerge, Some(StopReason::AutoMergeOff), StopReason::AutoMergeOff.describe());
            return Ok(());
        }
        // A commit GitHub refused is not offered to it again every few
        // minutes. A person asking, or a new head, is a new question.
        if merger == Merger::Pipeline && self.p.merge_refused.as_deref().is_some_and(|refused| same_commit(refused, commit)) {
            return Ok(());
        }
        let by = if merger == Merger::Person { MergedBy::Person } else { MergedBy::Pipeline };
        self.doing = "Merging the pull request";
        // Noted before the call: if the answer is lost on the way back, the
        // merge is still known to have been asked for, and by whom.
        self.p.merge_requested = Some(MergeRequest { commit: commit.to_string(), by, at: self.stamp() });
        self.p.merge_refused = None;
        match self.host.merge(&self.cwd, link.number, &self.settings.merge_method, commit) {
            Ok(PinnedMerge::Merged) => self.merged(link, commit, by),
            Ok(PinnedMerge::Accepted) => {
                self.settle(State::Waiting, None, format!("GitHub accepted the merge of {} and has not completed it yet.", short(commit)));
            }
            Ok(PinnedMerge::HeadMoved { head }) => {
                self.p.merge_requested = None;
                self.needs_you(StopReason::HeadMoved { reviewed: commit.to_string(), head });
            }
            Ok(PinnedMerge::Refused(message)) => {
                self.p.merge_requested = None;
                self.p.merge_refused = Some(commit.to_string());
                self.needs_you(StopReason::MergeRefused { message });
            }
            Err(error) => {
                // The request may have reached GitHub all the same; the pull
                // request knows. If it cannot be read either, the request
                // stays noted and the next look settles it.
                match self.host.pull_request(&self.cwd, link.number) {
                    Ok(now) if now.state == "MERGED" => self.merged(link, &now.head_sha, by),
                    Ok(_) => {
                        self.p.merge_requested = None;
                        return Err(error);
                    }
                    Err(_) => return Err(error),
                }
            }
        }
        Ok(())
    }

    /// For a pipeline that is not at the merge stage: has its pull request
    /// been merged or closed by someone meanwhile? Nothing else is looked at.
    fn notice_outcome(&mut self) -> Result<()> {
        let link = self.p.pr.clone().context("There is no pull request yet.")?;
        self.doing = "Reading the pull request";
        let pr = self.host.pull_request(&self.cwd, link.number)?;
        if pr.state == "OPEN" {
            return Ok(());
        }
        self.evaluate_snapshot(pr, Merger::Pipeline)
    }

    fn merged(&mut self, link: &PrLink, commit: &str, by: MergedBy) {
        if self.p.state == State::Merged {
            return;
        }
        let how = match by {
            MergedBy::Pipeline => "TerminalX merged",
            MergedBy::Person => "Merged from the issue page:",
            MergedBy::Elsewhere => "Merged outside this pipeline:",
        };
        let note = format!("{how} pull request #{} at {} into {}.", link.number, short(commit), link.base);
        self.p.merged = Some(MergeRecord { commit: commit.to_string(), at: self.stamp(), by });
        self.p.merge_requested = None;
        self.settle(State::Merged, None, note);
        if let Some(event) = self.p.events.last_mut() {
            event.commit = Some(commit.to_string());
            event.url = Some(link.url.clone());
        }
    }

    /// Push the current stage forward on a person's say-so.
    fn advance(&mut self) -> Result<()> {
        match self.p.stage {
            Stage::Work => {
                self.record("workDone", "Taken as done by a person.");
                self.open_pull_request()
            }
            Stage::PullRequest => self.open_pull_request(),
            Stage::Review => self.request_review(true),
            Stage::Address => {
                // Findings that never reached the author are sent, not skipped past.
                if let Some(verdict) = self.p.verdict.clone().filter(|verdict| self.p.findings_sent_round < verdict.round) {
                    return self.send_findings(&verdict);
                }
                self.record("workDone", "Taken as addressed by a person.");
                self.push_and_review()
            }
            Stage::Merge => {
                // A person asking is reason to put a refused merge to GitHub once more.
                self.p.merge_refused = None;
                self.evaluate(Merger::Pipeline)
            }
        }
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn verdict_line(verdict: &Verdict, max_rounds: u32) -> String {
    let blocking = verdict.blocking().count();
    let findings = match (verdict.findings.len(), blocking) {
        (0, _) => "no findings".to_string(),
        (all, 0) => format!("{all} finding{}, none of medium severity or higher", if all == 1 { "" } else { "s" }),
        (all, blocking) => format!("{all} finding{}, {blocking} of medium severity or higher", if all == 1 { "" } else { "s" }),
    };
    let decision = match (verdict.decision, blocking) {
        (verdict::Decision::Merge, 0) => "merge",
        _ => "changes requested",
    };
    let security = match verdict.security_pass {
        SecurityPass::NotNeeded => "",
        SecurityPass::Clean => " Security pass: clean.",
        SecurityPass::Flagged => " Security pass: flagged.",
    };
    format!("Review {} of {max_rounds} of {}: {decision}, {findings}.{security}", verdict.round, short(&verdict.commit))
}

// ---- what moves a pipeline -------------------------------------------------

/// Start a pipeline for a session that was started from an issue.
/// `auto_merge` is the issue's own switch; `None` takes the project's default.
/// `issue_body` is the issue's text as the session was started with it, kept
/// for the reviewer where the tracker cannot be read again (a cloud workspace).
pub fn start(host: &dyn Host, session_id: &str, tab_id: &str, auto_merge: Option<bool>, issue_body: Option<&str>) -> Result<Pipeline> {
    let session = host.session(session_id)?;
    let issue = session.issue.clone().ok_or_else(|| anyhow!("This session was not started from an issue."))?;
    if session.tab(tab_id).is_none() {
        bail!("tab {tab_id} not found in session {session_id}");
    }
    if let Some(existing) = store::for_session(session_id)?.filter(|pipeline| pipeline.author.session_id == session_id) {
        return Ok(existing);
    }
    let settings = host.settings(&session.project_path).context("The project's issue pipeline settings could not be read.")?;
    if !settings.enabled {
        bail!("The issue pipeline is turned off for this project.");
    }
    let workspace = host.workspace(Path::new(&session.cwd)).context("The issue pipeline needs a Git project.")?;
    let Some(branch) = workspace.branch.as_deref() else {
        bail!("The issue pipeline needs the session on a branch.");
    };
    if workspace.default_branch.as_deref() == Some(branch) {
        bail!("This session runs on {branch} itself, so there is no branch to open a pull request from. Start the issue in a worktree to have it carried to a pull request.");
    }
    let now = stamp(host.now());
    let cloud = host.cloud();
    // A cloud workspace's pipeline has no switch to turn on: it never merges.
    let auto_merge = !cloud && auto_merge.unwrap_or(settings.auto_merge);
    let issue_body = issue_body.map(str::trim).filter(|body| !body.is_empty()).map(|body| {
        let mut end = body.len().min(ISSUE_BODY_LIMIT);
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        if end < body.len() { format!("{}\n\n[…]", &body[..end]) } else { body.to_string() }
    });
    let mut pipeline = Pipeline {
        id: uuid::Uuid::now_v7().to_string(),
        project_path: session.project_path.clone(),
        issue: issue.clone(),
        branch: branch.to_string(),
        author: SessionRef { session_id: session_id.to_string(), tab_id: tab_id.to_string() },
        reviewer: None,
        auto_merge,
        cloud,
        issue_body,
        stopped: false,
        stage: Stage::Work,
        state: State::Working,
        reason: None,
        note: Some("The author session is working on the issue.".into()),
        pr: None,
        round: 0,
        max_rounds: settings.max_rounds,
        review_commit: None,
        review_requested_at: None,
        findings_sent_round: 0,
        verdict: None,
        security_areas: Vec::new(),
        summary: None,
        reminded: false,
        waiting_since: None,
        merge_requested: None,
        merge_refused: None,
        merged: None,
        events: Vec::new(),
        created: now.clone(),
        modified: now.clone(),
    };
    pipeline.record(&now, "started", format!("Session started on {} {}.", issue.identifier, issue.title)).session_id = Some(session_id.to_string());
    if auto_merge {
        pipeline.record(&now, "autoMerge", "Automatic merge is on for this issue.");
    }
    if cloud {
        pipeline.record(&now, "note", "In a cloud workspace the pipeline stops at Ready to merge. The merge is yours, from the issue page in TerminalX or on GitHub.");
    }
    store::insert(&pipeline)?;
    host.changed(&pipeline);
    Ok(pipeline)
}

/// A turn ended in some session. Nothing happens unless that tab is the
/// author or the reviewer of a pipeline.
pub fn turn_completed(host: &dyn Host, session_id: &str, tab_id: &str, final_message: Option<&str>) {
    let Some((pipeline, role)) = taking_part(session_id, tab_id) else {
        return;
    };
    let message = final_message.unwrap_or_default();
    let result = run(host, &pipeline.id, false, OnError::NeedsYou, |step| match role {
        Role::Author => step.author_turn(message),
        Role::Reviewer => step.reviewer_turn(message),
    });
    if let Err(error) = result {
        log::warn!("issue pipeline {}: {error:#}", pipeline.id);
    }
}

/// What a turn that ended without finishing is said to have done.
pub fn turn_failure(interrupted: bool) -> &'static str {
    if interrupted {
        "Its turn was interrupted."
    } else {
        "Its agent ended before the turn finished."
    }
}

/// A turn ended without finishing: interrupted, or the agent's process went.
pub fn turn_failed(host: &dyn Host, session_id: &str, tab_id: &str, detail: &str) {
    let Some((pipeline, role)) = taking_part(session_id, tab_id) else {
        return;
    };
    let result = run(host, &pipeline.id, false, OnError::NeedsYou, |step| {
        let waiting_on_it = match role {
            Role::Author => matches!(step.p.stage, Stage::Work | Stage::Address),
            Role::Reviewer => step.p.stage == Stage::Review,
        };
        if waiting_on_it && step.p.state == State::Working {
            step.needs_you(StopReason::SessionStopped { role: role.label().into(), detail: detail.to_string() });
        }
        Ok(())
    });
    if let Err(error) = result {
        log::warn!("issue pipeline {}: {error:#}", pipeline.id);
    }
}

fn taking_part(session_id: &str, tab_id: &str) -> Option<(Pipeline, Role)> {
    let pipeline = store::for_session(session_id).ok().flatten()?;
    let role = pipeline.role_of(session_id, tab_id)?;
    Some((pipeline, role))
}

/// Flip "Merge automatically when the review is addressed" for one issue.
/// Off takes effect at once, even against a step that is about to merge. On
/// merges a pull request that was only waiting for the switch.
pub fn set_auto_merge(host: &dyn Host, id: &str, value: bool) -> Result<Pipeline> {
    let stored = store::get(id)?;
    if value && (stored.cloud || host.cloud()) {
        bail!("{} is in a cloud workspace, which never merges by itself. Merge it from the issue page once it is ready.", stored.issue.identifier);
    }
    let was = stored.auto_merge;
    let switched = store::set_switches(id, |pipeline| pipeline.auto_merge = value)?;
    if was == value {
        return Ok(switched);
    }
    host.changed(&switched);
    run(host, id, true, OnError::NeedsYou, |step| {
        step.record("autoMerge", if value { "Automatic merge turned on." } else { "Automatic merge turned off." });
        match (&step.p.merge_requested, value) {
            // Turning it off stops a merge that has not been asked for. One
            // GitHub already took is GitHub's to complete, and saying
            // otherwise would be a comfort that is not true.
            (Some(request), false) if step.p.state != State::Merged => {
                let taken = format!("GitHub had already accepted the merge of {}; turning this off does not withdraw it.", short(&request.commit));
                step.record("note", taken);
            }
            (_, true) => step.p.merge_refused = None,
            _ => {}
        }
        let parked = step.p.stage == Stage::Merge && matches!(step.p.state, State::ReadyToMerge | State::Waiting | State::NeedsYou);
        if parked && !step.p.stopped {
            step.evaluate(Merger::Pipeline)?;
        }
        Ok(())
    })
}

/// What a person can do to a pipeline from the issue page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    /// Nothing further happens until it is resumed.
    Stop,
    Resume,
    /// Push the current stage forward: open the pull request, try again,
    /// review again, look at the checks again.
    Advance,
    /// Have the reviewer read the pull request's current head.
    Review,
    /// Merge the reviewed commit now.
    Merge,
    /// Look at the pull request again.
    Refresh,
}

/// What an action needs before it may touch anything. Asking for something
/// the pipeline is not in a position to do is refused and changes nothing.
fn refuse(pipeline: &Pipeline, action: Action) -> Result<()> {
    let reviewing = pipeline.stage == Stage::Review && pipeline.state == State::Working;
    match action {
        // Made on the reader's computer, with their own `gh` (`note_merge`).
        Action::Merge if pipeline.cloud => bail!("{} is in a cloud workspace: it is merged from the issue page in TerminalX on your computer, with your own GitHub sign-in.", pipeline.issue.identifier),
        Action::Merge if pipeline.state != State::ReadyToMerge => bail!("{} is not at Ready to merge.", pipeline.issue.identifier),
        Action::Review if pipeline.pr.is_none() => bail!("{} has no pull request to review yet.", pipeline.issue.identifier),
        Action::Review | Action::Advance if reviewing => bail!("A review of {} is already under way.", pipeline.issue.identifier),
        Action::Review | Action::Advance | Action::Stop | Action::Refresh if pipeline.state == State::Merged => bail!("{} is merged.", pipeline.issue.identifier),
        Action::Review | Action::Advance | Action::Merge if pipeline.stopped => bail!("{} is stopped. Resume it first.", pipeline.issue.identifier),
        _ => Ok(()),
    }
}

pub fn act(host: &dyn Host, id: &str, action: Action) -> Result<Pipeline> {
    // Refused here for the caller's sake, and again under the pipeline's lock:
    // a step that was running while this waited may have changed the answer,
    // and then the action is quietly dropped.
    refuse(&store::get(id)?, action)?;
    let still = move |step: &Step<'_>| refuse(&step.p, action).is_ok();
    match action {
        Action::Stop => {
            let stopped = store::set_switches(id, |pipeline| pipeline.stopped = true)?;
            host.changed(&stopped);
            run(host, id, true, OnError::NeedsYou, |step| {
                // A merge that went through while this waited stays a merge.
                if step.p.state != State::Merged {
                    step.settle(State::Stopped, None, "Stopped. Nothing further happens until it is resumed.");
                }
                Ok(())
            })
        }
        Action::Resume => {
            store::set_switches(id, |pipeline| pipeline.stopped = false)?;
            run(host, id, false, OnError::NeedsYou, |step| {
                if step.p.state != State::Stopped {
                    return Ok(());
                }
                step.record("resumed", "Resumed.");
                match step.p.stage {
                    // The author may have finished while it was stopped; only it, or a person, can say.
                    Stage::Work | Stage::Address => {
                        step.settle(State::Working, None, "Waiting for the author session to report.");
                        Ok(())
                    }
                    Stage::PullRequest => step.open_pull_request(),
                    Stage::Review => step.request_review(true),
                    Stage::Merge => step.evaluate(Merger::Pipeline),
                }
            })
        }
        Action::Advance => run(host, id, false, OnError::NeedsYou, |step| if still(step) { step.advance() } else { Ok(()) }),
        Action::Review => run(host, id, false, OnError::NeedsYou, |step| if still(step) { step.request_review(true) } else { Ok(()) }),
        Action::Merge => run(host, id, false, OnError::NeedsYou, |step| if still(step) { step.evaluate(Merger::Person) } else { Ok(()) }),
        Action::Refresh => run(host, id, false, OnError::Report, |step| if step.p.stage == Stage::Merge && step.p.pr.is_some() { step.evaluate(Merger::Pipeline) } else { Ok(()) }),
    }
}

/// A person merged a cloud workspace's pull request from their computer, with
/// their own `gh`, pinned to `commit`. The runtime reads the pull request
/// itself to settle it: merged, taken into a merge queue, or not merged after
/// all. A pull request it cannot read yet keeps the merge noted, and the
/// next look settles it.
pub fn note_merge(host: &dyn Host, id: &str, commit: &str) -> Result<Pipeline> {
    run(host, id, true, OnError::Report, |step| {
        if step.p.state == State::Merged {
            return Ok(());
        }
        step.p.pr.as_ref().context("There is no pull request to merge.")?;
        step.p.merge_requested = Some(MergeRequest { commit: commit.to_string(), by: MergedBy::Person, at: step.stamp() });
        step.p.merge_refused = None;
        if let Err(error) = step.evaluate(Merger::Pipeline) {
            step.record("note", format!("Merged from the issue page at {}; the pull request could not be read back yet: {error:#}", short(commit)));
        }
        Ok(())
    })
}

/// A desktop moved a cloud workspace's Linear issue to its team's review
/// state, with the reader's own Linear key, once the pull request was open:
/// the runtime has no key to do it with. Recorded once, as the tracker line
/// of the pull request stage.
pub fn note_tracker(host: &dyn Host, id: &str, message: &str) -> Result<Pipeline> {
    run(host, id, true, OnError::Report, |step| {
        if !step.p.cloud || step.p.issue.provider != "linear" {
            bail!("{} is not a Linear issue carried by a cloud workspace.", step.p.issue.identifier);
        }
        if step.p.pr.is_none() {
            bail!("{} has no pull request yet.", step.p.issue.identifier);
        }
        if step.p.events.iter().any(|event| event.kind == "tracker") {
            return Ok(());
        }
        let url = step.p.issue.url.clone();
        step.record("tracker", message).url = Some(url);
        Ok(())
    })
}

/// How often a pipeline that is parked on a person is looked at again, for a
/// merge made elsewhere or a head that moved.
const PARKED_EVERY_MINUTES: i64 = 5;
/// A parked pipeline nobody has touched for this long is only looked at when
/// its issue is opened.
const PARKED_FOR_DAYS: i64 = 14;
/// Parked pipelines looked at per pass, so a long list is not one burst of calls.
const PARKED_PER_PASS: usize = 3;

/// One pass over the pipelines that are waiting on GitHub.
pub fn poll(host: &dyn Host) {
    static LOOKED: Mutex<BTreeMap<String, DateTime<Utc>>> = Mutex::new(BTreeMap::new());
    let Ok(pipelines) = store::list() else {
        return;
    };
    let now = host.now();
    let mut parked = 0;
    for pipeline in pipelines.into_iter().filter(|pipeline| !pipeline.stopped && pipeline.pr.is_some()) {
        let at_gate = pipeline.stage == Stage::Merge;
        let due = match pipeline.state {
            State::Waiting | State::Working => at_gate,
            // Parked on a person, at any stage: they may have merged or
            // closed the pull request by hand.
            State::ReadyToMerge | State::NeedsYou => {
                let recent = DateTime::parse_from_rfc3339(&pipeline.modified).is_ok_and(|modified| (now - modified.with_timezone(&Utc)).num_days() < PARKED_FOR_DAYS);
                let looked = LOOKED.lock().unwrap_or_else(|error| error.into_inner()).get(&pipeline.id).copied();
                let due = recent && parked < PARKED_PER_PASS && looked.is_none_or(|looked| (now - looked).num_minutes() >= PARKED_EVERY_MINUTES);
                parked += usize::from(due);
                due
            }
            State::Merged | State::Stopped => false,
        };
        if !due {
            continue;
        }
        LOOKED.lock().unwrap_or_else(|error| error.into_inner()).insert(pipeline.id.clone(), now);
        // GitHub being unreachable for a pass changes nothing and is tried again.
        let look = |step: &mut Step<'_>| if step.p.stage == Stage::Merge { step.evaluate(Merger::Pipeline) } else { step.notice_outcome() };
        if let Err(error) = run(host, &pipeline.id, false, OnError::Report, look) {
            log::warn!("issue pipeline {}: {error:#}", pipeline.id);
            // But not for ever: a wait that has run out stops for a person
            // even while GitHub cannot be read, as it would once it could.
            let ran_out = pipeline.state == State::Waiting && store::waiting_since(&pipeline).is_some_and(|since| (now - since).num_minutes() >= i64::from(CHECKS_WAIT_MINUTES));
            if ran_out {
                let message = format!("It waited {CHECKS_WAIT_MINUTES} minutes for GitHub, and GitHub could not be read: {error:#}");
                let stop = |step: &mut Step<'_>| {
                    if step.p.state == State::Waiting {
                        step.needs_you(StopReason::Failed { step: "Reading the pull request".into(), message: message.clone() });
                    }
                    Ok(())
                };
                if let Err(error) = run(host, &pipeline.id, false, OnError::NeedsYou, stop) {
                    log::warn!("issue pipeline {}: {error:#}", pipeline.id);
                }
            }
        }
    }
}

/// After the app starts: whatever a pipeline was in the middle of did not
/// survive the restart, and it says so rather than showing "working" for ever.
pub fn recover(host: &dyn Host) {
    let Ok(pipelines) = store::list() else {
        return;
    };
    for pipeline in pipelines.into_iter().filter(|pipeline| !pipeline.stopped && pipeline.state == State::Working && pipeline.stage != Stage::Merge) {
        let result = run(host, &pipeline.id, false, OnError::NeedsYou, |step| {
            let closed = "TerminalX was closed before it finished.";
            let reason = match step.p.stage {
                Stage::Work | Stage::Address => StopReason::SessionStopped { role: Role::Author.label().into(), detail: closed.into() },
                Stage::Review => StopReason::SessionStopped { role: Role::Reviewer.label().into(), detail: closed.into() },
                Stage::PullRequest | Stage::Merge => StopReason::Failed { step: "Opening the pull request".into(), message: closed.into() },
            };
            step.needs_you(reason);
            Ok(())
        });
        if let Err(error) = result {
            log::warn!("issue pipeline {}: {error:#}", pipeline.id);
        }
    }
}

/// After a cloud workspace's runtime starts. A workspace is put to sleep and
/// woken as a matter of course, so unlike [`recover`] a pipeline picks up
/// where it was: one waiting for a session's report keeps waiting, and one at
/// the merge stage is looked at by the poller. A report the session gave just
/// before the restart, whose step was lost with it (its turn ended after the
/// pipeline last changed), is taken now. Only what the restart did end is
/// said: a turn that was running in the author's or the reviewer's tab
/// (`interrupted`), and a pull request that was being opened.
pub fn resume(host: &dyn Host, interrupted: &[(String, String)]) {
    let Ok(pipelines) = store::list() else {
        return;
    };
    let ended = |session: &SessionRef| interrupted.iter().any(|(session_id, tab_id)| *session_id == session.session_id && *tab_id == session.tab_id);
    let restarted = "The workspace's runtime restarted during its turn.";
    for pipeline in pipelines.into_iter().filter(|pipeline| !pipeline.stopped && pipeline.state == State::Working) {
        let waits_on = match pipeline.stage {
            Stage::Work | Stage::Address => Some(pipeline.author.clone()),
            Stage::Review => pipeline.reviewer.clone(),
            Stage::PullRequest | Stage::Merge => None,
        };
        if let Some(session) = waits_on.filter(|session| !ended(session)) {
            let changed = DateTime::parse_from_rfc3339(&pipeline.modified).ok().map(|at| at.with_timezone(&Utc));
            if let Some((_, reply)) = host.last_reply(&session).filter(|(at, _)| changed.is_some_and(|changed| *at > changed)) {
                turn_completed(host, &session.session_id, &session.tab_id, Some(&reply));
            }
            continue;
        }
        let reason = match pipeline.stage {
            Stage::Work | Stage::Address if ended(&pipeline.author) => StopReason::SessionStopped { role: Role::Author.label().into(), detail: restarted.into() },
            Stage::Review if pipeline.reviewer.as_ref().is_some_and(ended) => StopReason::SessionStopped { role: Role::Reviewer.label().into(), detail: restarted.into() },
            Stage::PullRequest => StopReason::Failed { step: "Opening the pull request".into(), message: "The workspace's runtime restarted before it finished.".into() },
            _ => continue,
        };
        if let Err(error) = run(host, &pipeline.id, false, OnError::NeedsYou, |step| {
            // Settled by something else since the list was read.
            if step.p.state == State::Working && step.p.stage == pipeline.stage {
                step.needs_you(reason);
            }
            Ok(())
        }) {
            log::warn!("issue pipeline {}: {error:#}", pipeline.id);
        }
    }
}
