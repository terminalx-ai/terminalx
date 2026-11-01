//! Archived sessions (#718): out of the sidebar's list, kept whole, and back
//! in it at their next message.
//!
//! Archiving hides a session and nothing more. Its transcript, its worktree
//! and its agent's own conversation stay as they are, and it is listed under
//! Show archived, found by the command palette and by
//! `terminalx sessions list --archived`. Every way in or out goes through
//! [`set_archived`]: a row's menu, the sidebar's bulk bar, removing a
//! project, the CLI, the idle sweep, and a new message, so whichever did it
//! the windows hear of it the same way (`session_updated`) at once.
//!
//! **The idle sweep.** A session nobody has written in for the limit in
//! Settings (a week unless the reader chose another, or never) is archived
//! by [`sweep`], unless any of these holds ([`Kept`]):
//!
//! - it is pinned, or open in a window;
//! - a tab is in a turn, waits on a permission or a question, holds a
//!   message waiting to be sent, waits on work its agent left running, or
//!   has a terminal in use;
//! - its last reply has not been read;
//! - its own worktree has uncommitted changes, or commits no other branch,
//!   remote or tag has;
//! - an issue pipeline it takes part in still waits on its pull request.
//!
//! Idle is the time since the last message in any of its tabs
//! ([`last_active`]), or since it last came back from the archive, not
//! since it was created. Stopping its idle agents stays `idle_agents.rs`'s.
//!
//! **Coming back.** A message sent to an archived session (from the window,
//! the CLI, a phone, a shared session's guest, an automation or a pipeline)
//! is a new message in it like any other, and `SessionManager::publish`
//! brings the session back as the message is recorded ([`bring_back`]).

use std::collections::HashSet;
use std::path::Path;

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry, TabStatus};

/// Who archived a session, or brought it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum By {
    /// A person: a row's menu, the bulk bar, removing a project, the CLI.
    Person,
    /// The idle sweep.
    Idle,
    /// A new message in it.
    Message,
}

/// Archive or bring back every one of `ids`, or none of them when one is
/// not a session. Returns them as they are now, in the order asked, and
/// tells the windows about each one that changed.
pub fn set_archived(sink: &dyn EventSink, ids: &[String], archived: bool, by: By) -> Result<Vec<SessionEntry>> {
    let (sessions, changed) = apply(ids, archived, by)?;
    for session in sessions.iter().filter(|session| changed.contains(&session.id)) {
        sink.emit("session_updated", session);
    }
    Ok(sessions)
}

/// [`set_archived`] without telling anybody: what changed is the second half.
fn apply(ids: &[String], archived: bool, by: By) -> Result<(Vec<SessionEntry>, HashSet<String>)> {
    let now = index::now();
    let mut seen = HashSet::new();
    let ids: Vec<&String> = ids.iter().filter(|id| seen.insert(id.as_str())).collect();
    let (mut sessions, changed) = index::update(|sessions| {
        if let Some(missing) = ids.iter().find(|id| !sessions.iter().any(|session| &session.id == **id)) {
            bail!("session {missing} not found");
        }
        let mut out = Vec::with_capacity(ids.len());
        let mut changed = HashSet::new();
        for id in &ids {
            let session = sessions.iter_mut().find(|session| &session.id == *id).expect("checked above");
            if mark(session, archived, by, &now) {
                changed.insert(session.id.clone());
            }
            out.push(session.clone());
        }
        Ok((out, changed))
    })?;
    // What the windows hear carries the session's message time, as a list read does.
    crate::store::message_activity::project(&mut sessions)?;
    Ok((sessions, changed))
}

/// Put one session in or out of the archive; whether anything changed.
/// `update_session_meta` marks a remote client's archive with it too.
pub(crate) fn mark(session: &mut SessionEntry, archived: bool, by: By, now: &str) -> bool {
    if session.archived == archived {
        // A person archiving what the sweep archived makes it theirs: set
        // aside on purpose, which retention then leaves alone.
        if archived && by == By::Person && session.archive.auto_archived {
            session.archive.auto_archived = false;
            return true;
        }
        return false;
    }
    session.archived = archived;
    session.archive.auto_archived = archived && by == By::Idle;
    if !archived {
        session.archive.unarchived_at = Some(now.to_string());
    }
    // The sweep is nobody's doing; a person's choice and a message are, as before.
    if by != By::Idle {
        session.modified = now.to_string();
    }
    true
}

/// A new message was recorded in `session`, which is archived: it is back
/// in the list. The caller tells the windows, with what this returns.
pub fn bring_back(session: SessionEntry) -> SessionEntry {
    match apply(std::slice::from_ref(&session.id), false, By::Message) {
        Ok((mut sessions, _)) => sessions.pop().unwrap_or(session),
        Err(error) => {
            log::warn!("bring {} back from the archive: {error:#}", session.id);
            session
        }
    }
}

/// Why a session that may have gone quiet is not archived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kept {
    /// Written in within the limit, or brought back from the archive since.
    Recent,
    Pinned,
    /// Open in a window.
    Shown,
    /// A tab in a turn, waiting on work its agent left running, or a
    /// terminal of the session in use.
    Working,
    /// A tab waiting on a permission or a question.
    WaitingForYou,
    /// A message waiting to be sent.
    Queued,
    /// A reply nobody has read.
    Unread,
    /// Uncommitted changes, or commits nothing else has, in its own worktree.
    LocalWork,
    /// An issue pipeline it takes part in still waits on its pull request.
    PipelineOpen,
}

/// When a session was last written in: its newest message in any tab, its
/// closed ones too, or when it last came back from the archive, whichever is
/// later. A session no message of which was ever timed (all of it written
/// before message times were kept, #600) goes by `logs_written`, when its
/// tabs' logs were last written, and else by when it was created. `None`
/// when no time can be read: not knowing is not idle.
pub fn last_active(session: &SessionEntry, logs_written: impl FnOnce() -> Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    let parse = |value: &str| DateTime::parse_from_rfc3339(value).ok().map(|time| time.with_timezone(&Utc));
    let message = crate::store::message_activity::last_message_at(session)
        .or_else(logs_written)
        .or_else(|| parse(&session.created));
    let back = session.archive.unarchived_at.as_deref().and_then(parse);
    message.max(back)
}

/// When any tab log of the session was last written, closed tabs' too.
fn logs_written(session_id: &str) -> Option<DateTime<Utc>> {
    let dir = crate::store::sessions_dir().ok()?.join(session_id);
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "jsonl"))
        .filter_map(|entry| entry.metadata().ok()?.modified().ok())
        .max()
        .map(DateTime::<Utc>::from)
}

/// What a sweep goes by besides the session itself.
pub struct Sweep<'a> {
    /// How long a session may go without a message.
    pub limit: chrono::Duration,
    pub now: DateTime<Utc>,
    /// Sessions open in a window.
    pub shown: &'a HashSet<String>,
    /// What only the runtime that owns the agents knows ([`busy`]).
    pub busy: &'a dyn Fn(&SessionEntry) -> Option<Kept>,
    /// Sessions that take part in a pipeline still waiting on its pull
    /// request ([`in_open_pipelines`]).
    pub in_pipelines: &'a HashSet<String>,
    /// Whether a session's own worktree holds work nothing else has ([`local_work`]).
    pub local_work: &'a dyn Fn(&SessionEntry) -> bool,
    /// When a session's tab logs were last written, for one with no message time.
    pub logs_written: &'a dyn Fn(&SessionEntry) -> Option<DateTime<Utc>>,
}

/// Why `session` stays in the list, or `None` when it goes to the archive.
/// What is cheap to know is asked first; the worktree, last.
pub fn kept(session: &SessionEntry, sweep: &Sweep) -> Option<Kept> {
    if session.pinned {
        return Some(Kept::Pinned);
    }
    if sweep.shown.contains(&session.id) {
        return Some(Kept::Shown);
    }
    let quiet = last_active(session, || (sweep.logs_written)(session)).is_some_and(|last| sweep.now - last >= sweep.limit);
    if !quiet {
        return Some(Kept::Recent);
    }
    // As the index last had it: a runtime that has not looked at the tab since still says so.
    for tab in &session.tabs {
        match tab.status {
            TabStatus::InProgress => return Some(Kept::Working),
            TabStatus::Waiting => return Some(Kept::WaitingForYou),
            TabStatus::Completed => return Some(Kept::Unread),
            TabStatus::Idle => {}
        }
    }
    if let Some(why) = (sweep.busy)(session) {
        return Some(why);
    }
    if sweep.in_pipelines.contains(&session.id) {
        return Some(Kept::PipelineOpen);
    }
    if (sweep.local_work)(session) {
        return Some(Kept::LocalWork);
    }
    None
}

/// Archive every session [`kept`] lets go. Returns them, archived, after
/// telling the windows. Each one is looked at again under the index's lock
/// before it goes, so a message that landed meanwhile keeps it.
pub fn sweep(sink: &dyn EventSink, sweep: &Sweep) -> Result<Vec<SessionEntry>> {
    let sessions = index::load()?;
    let due: Vec<String> = sessions
        .iter()
        .filter(|session| !session.archived)
        .filter(|session| match kept(session, sweep) {
            Some(why) => {
                log::trace!("archive: {} kept ({why:?})", session.id);
                false
            }
            None => true,
        })
        .map(|session| session.id.clone())
        .collect();
    if due.is_empty() {
        return Ok(Vec::new());
    }
    let now = index::now();
    let mut archived = index::update(|sessions| {
        let mut out = Vec::new();
        for session in sessions.iter_mut().filter(|session| due.contains(&session.id)) {
            // The list read above carried the message times; the file under the lock does not.
            let mut again = session.clone();
            crate::store::message_activity::project(std::slice::from_mut(&mut again))?;
            let still = !again.archived && !again.pinned && !sweep.shown.contains(&again.id)
                && last_active(&again, || (sweep.logs_written)(&again)).is_some_and(|last| sweep.now - last >= sweep.limit)
                && again.tabs.iter().all(|tab| tab.status == TabStatus::Idle);
            if still && mark(session, true, By::Idle, &now) {
                out.push(session.clone());
            }
        }
        Ok(out)
    })?;
    crate::store::message_activity::project(&mut archived)?;
    for session in &archived {
        log::info!("archive: {} had no message for {} days", session.id, sweep.limit.num_days());
        sink.emit("session_updated", session);
    }
    Ok(archived)
}

/// What the runtime that owns the agents knows keeps `session`: a tab in a
/// turn, asking, holding a message, or waiting on work its agent left
/// running, or a terminal of the session in use. `live_shells` names the
/// session of each shell that has not exited.
pub fn busy(manager: &crate::session::SessionManager, session: &SessionEntry, live_shells: &[&str]) -> Option<Kept> {
    for tab in &session.tabs {
        let view = manager.wait_view(&session.id, &tab.id);
        if view.asks || view.status == TabStatus::Waiting {
            return Some(Kept::WaitingForYou);
        }
        if view.queued {
            return Some(Kept::Queued);
        }
        if view.status == TabStatus::InProgress || !manager.pipeline_idle(&session.id, &tab.id) {
            return Some(Kept::Working);
        }
        if view.status == TabStatus::Completed {
            return Some(Kept::Unread);
        }
        if manager.background_work(&session.id, &tab.id).is_some() {
            return Some(Kept::Working);
        }
    }
    let terminals = manager.terminals();
    crate::session_ops::has_shell_in_use(session, live_shells, |pane| terminals.is_running(pane)).then_some(Kept::Working)
}

/// The sessions taking part in an issue pipeline that still waits on its
/// pull request (`issue_pipeline::engine::waits_on_pull_request`): its
/// author, reviewer and resolver.
pub fn in_open_pipelines() -> Result<HashSet<String>> {
    let mut sessions = HashSet::new();
    for pipeline in crate::issue_pipeline::store::list()?.iter().filter(|pipeline| crate::issue_pipeline::engine::waits_on_pull_request(pipeline)) {
        sessions.insert(pipeline.author.session_id.clone());
        sessions.extend(pipeline.reviewer.iter().chain(pipeline.resolver.iter()).map(|part| part.session_id.clone()));
    }
    Ok(sessions)
}

/// Whether a session's own worktree holds work nothing else has: changes
/// not committed, or commits no other branch, remote or tag has. A session
/// in its project's own checkout has no worktree of its own, nor one whose
/// workspace was removed. One whose folder is gone holds nothing; one git
/// cannot read is said to hold work, since not knowing is not finished.
pub fn local_work(session: &SessionEntry) -> bool {
    if session.worktree_name.is_none() || session.worktree_removed {
        return false;
    }
    let cwd = Path::new(&session.cwd);
    if !cwd.is_dir() {
        return false;
    }
    match crate::git::run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"]) {
        Ok(status) if status.trim().is_empty() => {}
        _ => return true,
    }
    // Commits on HEAD that are on no other branch (`--exclude` takes its own
    // out of `--branches`), remote or tag. A detached HEAD has none of its own.
    let own = crate::git::current_branch(cwd).map(|branch| format!("--exclude={branch}"));
    let mut args = vec!["rev-list", "--count", "HEAD", "--not"];
    args.extend(own.as_deref());
    args.extend(["--branches", "--remotes", "--tags"]);
    crate::git::run(cwd, &args).ok().and_then(|count| count.trim().parse::<u32>().ok()).is_none_or(|count| count > 0)
}

/// One sweep in the runtime that owns the agents, with what it knows of
/// them. `shown`: the sessions open in a window. Nothing is archived while
/// the limit is Never, or while the pipelines cannot be read.
pub fn sweep_owned(manager: &crate::session::SessionManager, sink: &dyn EventSink, shown: &HashSet<String>) -> Result<Vec<SessionEntry>> {
    let Some(limit) = crate::store::settings::load().conversations.archive_after() else {
        return Ok(Vec::new());
    };
    let shells = manager.terminals().shells();
    let live: Vec<&str> = shells.iter().filter(|shell| !shell.exited).map(|shell| shell.session_id.as_str()).collect();
    let in_pipelines = in_open_pipelines()?;
    sweep(
        sink,
        &Sweep {
            limit,
            now: Utc::now(),
            shown,
            busy: &|session| busy(manager, session, &live),
            in_pipelines: &in_pipelines,
            local_work: &local_work,
            logs_written: &|session| logs_written(&session.id),
        },
    )
}

#[cfg(test)]
#[path = "session_archive_tests.rs"]
mod tests;
