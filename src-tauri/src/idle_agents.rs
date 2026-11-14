//! Agents nobody is using are stopped (#696).
//!
//! An idle Claude Code process holds 350–750 MB, and every agent runs its own
//! MCP servers and language server besides: left alone, a few days of work
//! kept 26 GB in agents waiting for nothing. Every [`EVERY`] the runtime that
//! owns the agents looks at each one the app started:
//!
//! - one that has had nothing to do for the limit in Settings → Agents (an
//!   hour unless the reader chose another, or never) is stopped;
//! - one in a session the reader set aside, archived or with its workspace
//!   removed, is stopped once it has had nothing to do for
//!   [`SET_ASIDE_GRACE`], whatever that limit is. Opening such a session's
//!   tab does not start its agent (`SessionManager::start_on_open`); one a
//!   message started there is let go again once the reader leaves it.
//!
//! Nothing to do means no turn, no prompt waiting to be taken or answered, no
//! question, no restart, nothing drawn, and nothing left running that the
//! agent waits on: a command, monitor or agent it ran in the background and
//! has not heard back from, a wakeup or cron job it scheduled, or a process
//! one of its commands left behind (`SessionManager::background_work`). Such
//! work ends with the agent, and its turns start without anybody's prompt,
//! so an agent waiting on it is at work, however quiet. Starting more of it
//! takes a turn, which `SessionManager::stop_if_idle` sees when it looks
//! again under the admission lock before it stops anything. A terminal, an
//! agent a person started by hand in one, and a tab at work or waiting on an
//! answer are never stopped. A stopped agent leaves a line in its
//! transcript, its conversation stays (unread, if it was), and its next
//! message starts it again on the same conversation.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::session::{AgentStop, SessionManager};
use crate::store::index::{self, SessionEntry};

/// How often the agents are looked at.
pub const EVERY: Duration = Duration::from_secs(60);

/// How long an agent in an archived session, or one whose workspace was
/// removed, may have nothing to do: long enough for a reader who opened it
/// to send another message without waiting for it to start again.
pub const SET_ASIDE_GRACE: Duration = Duration::from_secs(10 * 60);

/// The line an agent stopped from App resources leaves in its transcript.
pub const STOPPED_FROM_RESOURCES: &str = "Stopped from App resources. Your next message starts the agent again on this conversation.";

/// Why an agent is stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// It had nothing to do for the reader's limit.
    Idle(Duration),
    Archived,
    WorkspaceRemoved,
}

impl Why {
    /// How long the agent must have had nothing to do; looked at again just
    /// before it is stopped.
    pub fn after(self) -> Duration {
        match self {
            Why::Idle(limit) => limit,
            Why::Archived | Why::WorkspaceRemoved => SET_ASIDE_GRACE,
        }
    }

    /// The line it leaves in the agent's transcript.
    pub fn note(self) -> String {
        match self {
            Why::Idle(limit) => format!("Stopped after {} with nothing to do. Your next message starts the agent again on this conversation.", span(limit)),
            Why::Archived => "Stopped: the session is archived and its agent had nothing to do. Your next message starts it again on this conversation.".into(),
            Why::WorkspaceRemoved => "Stopped: this session's workspace was removed and its agent had nothing to do. Your next message starts it again on this conversation, in the project's folder.".into(),
        }
    }
}

/// "30 minutes", "an hour", "4 hours", "a day".
fn span(limit: Duration) -> String {
    let minutes = limit.as_secs() / 60;
    match minutes {
        0 => "less than a minute".into(),
        1 => "a minute".into(),
        60 => "an hour".into(),
        1440 => "a day".into(),
        m if m % 1440 == 0 => format!("{} days", m / 1440),
        m if m % 60 == 0 => format!("{} hours", m / 60),
        m => format!("{m} minutes"),
    }
}

/// Whether an agent of `session` that has had nothing to do for `idle` is to
/// be stopped, and why. `limit` is the reader's; `None` keeps an agent the
/// reader has not set aside running for as long as it likes.
pub fn due(session: &SessionEntry, idle: Duration, limit: Option<Duration>) -> Option<Why> {
    let set_aside = if session.worktree_removed {
        Some(Why::WorkspaceRemoved)
    } else if session.archived {
        Some(Why::Archived)
    } else {
        None
    };
    let reasons = set_aside.into_iter().chain(limit.map(Why::Idle));
    reasons.filter(|why| idle >= why.after()).min_by_key(|why| why.after())
}

/// One look at every agent: each that is due is stopped. What was stopped:
/// `(session id, tab id, why)`.
pub fn sweep(manager: &SessionManager, limit: Option<Duration>, now: Instant) -> Vec<(String, String, Why)> {
    let idle = manager.idle_agents(now);
    if idle.is_empty() {
        return Vec::new();
    }
    let sessions = match index::load() {
        Ok(sessions) => sessions,
        Err(error) => {
            log::warn!("idle agents: the session index could not be read: {error:#}");
            return Vec::new();
        }
    };
    let mut stopped = Vec::new();
    for (session_id, tab_id, quiet) in idle {
        let Some(session) = sessions.iter().find(|session| session.id == session_id) else { continue };
        let Some(why) = due(session, quiet, limit) else { continue };
        if let Some(what) = manager.background_work(&session_id, &tab_id) {
            log::debug!("idle agents: {session_id}:{tab_id} waits on {what}");
            continue;
        }
        match manager.stop_if_idle(&session_id, &tab_id, &why.note(), why.after()) {
            Ok(AgentStop::Stopped) => {
                log::info!("idle agents: stopped {session_id}:{tab_id} ({why:?}, idle {}s)", quiet.as_secs());
                stopped.push((session_id, tab_id, why));
            }
            Ok(AgentStop::Busy | AgentStop::NotRunning) => {}
            Err(error) => log::warn!("idle agents: stopping {session_id}:{tab_id}: {error:#}"),
        }
    }
    stopped
}

/// A process in the agent's process group that no longer descends from the
/// agent (`leader`, the group's first process): something one of its
/// commands started and left running, `nohup … &` or a server that went into
/// the background. Stopping the agent ends its group, and that with it. The
/// agent's own children, its MCP and language servers among them, still
/// descend from it and do not count. Processes that cannot be read are said
/// to be there: not knowing is not idle.
pub fn left_running(leader: u32) -> Option<String> {
    let program = if std::path::Path::new("/bin/ps").exists() { "/bin/ps" } else { "ps" };
    let listed = std::process::Command::new(program).args(["-A", "-o", "pid=,ppid=,pgid="]).env("LC_ALL", "C").output();
    match listed {
        Ok(output) if output.status.success() => match strays(&String::from_utf8_lossy(&output.stdout), leader) {
            0 => None,
            1 => Some("a process it left running".into()),
            n => Some(format!("{n} processes it left running")),
        },
        _ => Some("processes that could not be checked".into()),
    }
}

/// How many members of `leader`'s process group in a `pid ppid pgid` table
/// do not descend from it.
fn strays(table: &str, leader: u32) -> usize {
    let mut parents = HashMap::new();
    let mut members = Vec::new();
    for line in table.lines() {
        let fields: Vec<u32> = line.split_whitespace().filter_map(|field| field.parse().ok()).collect();
        let [pid, ppid, pgid] = fields[..] else { continue };
        parents.insert(pid, ppid);
        if pgid == leader && pid != leader {
            members.push(pid);
        }
    }
    let descends = |pid: u32| {
        let mut at = pid;
        // A chain of parents is short; the bound only guards a table read
        // while it changed.
        for _ in 0..256 {
            match parents.get(&at) {
                Some(&parent) if parent == leader => return true,
                Some(&parent) if parent > 1 && parent != at => at = parent,
                _ => return false,
            }
        }
        false
    };
    members.into_iter().filter(|pid| !descends(*pid)).count()
}

/// Look at the agents every [`EVERY`], for as long as the runtime runs. The
/// limit is read again each time, so a change in Settings applies at once.
pub fn start(manager: SessionManager) {
    let spawned = std::thread::Builder::new().name("idle-agents".into()).spawn(move || loop {
        std::thread::sleep(EVERY);
        let limit = crate::store::settings::load().agents.idle_limit();
        sweep(&manager, limit, Instant::now());
    });
    if let Err(error) = spawned {
        log::error!("start the idle agent sweep: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(archived: bool, worktree_removed: bool) -> SessionEntry {
        let mut entry: SessionEntry = serde_json::from_value(serde_json::json!({ "id": "s1", "projectPath": "/work", "cwd": "/work", "title": "t", "created": "x", "modified": "y" })).unwrap();
        entry.archived = archived;
        entry.worktree_removed = worktree_removed;
        entry
    }

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn an_agent_is_due_once_idle_for_the_readers_limit_and_never_when_there_is_none() {
        let live = session(false, false);
        let hour = Some(60 * MINUTE);
        assert_eq!(due(&live, 59 * MINUTE, hour), None);
        assert_eq!(due(&live, 60 * MINUTE, hour), Some(Why::Idle(60 * MINUTE)));
        assert_eq!(due(&live, 30 * 24 * 60 * MINUTE, None), None);
    }

    #[test]
    fn a_set_aside_session_lets_its_agent_go_after_the_grace_whatever_the_limit() {
        for limit in [None, Some(60 * MINUTE), Some(24 * 60 * MINUTE)] {
            assert_eq!(due(&session(true, false), 9 * MINUTE, limit), None);
            assert_eq!(due(&session(true, false), 10 * MINUTE, limit), Some(Why::Archived));
            assert_eq!(due(&session(false, true), 10 * MINUTE, limit), Some(Why::WorkspaceRemoved));
            // Removed is said first: it is why the session is archived now.
            assert_eq!(due(&session(true, true), 10 * MINUTE, limit), Some(Why::WorkspaceRemoved));
        }
        // A limit shorter than the grace is the one that applies.
        assert_eq!(due(&session(true, false), 5 * MINUTE, Some(5 * MINUTE)), Some(Why::Idle(5 * MINUTE)));
    }

    /// The agent's servers and the command it runs descend from it; what a
    /// command left behind was handed to launchd and does not.
    #[test]
    fn a_process_left_in_the_agents_group_counts_and_its_own_children_do_not() {
        let table = "\
          1     0     1
        400     1   400
        410   400   400
        411   410   400
        420   400   400
        500     1   400
        501   500   400
        600     1   600
        700   400   700
        ";
        // 410 and 411 (a server and its child), 420 (a command): its own.
        // 500 and 501: left running. 600 and 700: other groups.
        assert_eq!(strays(table, 400), 2);
        assert_eq!(strays(table, 600), 0);
        assert_eq!(strays("garbage\n400 1\n", 400), 0);
    }

    #[test]
    fn the_note_says_how_long_and_what_starts_the_agent_again() {
        assert_eq!(Why::Idle(60 * MINUTE).note(), "Stopped after an hour with nothing to do. Your next message starts the agent again on this conversation.");
        assert!(Why::Idle(30 * MINUTE).note().starts_with("Stopped after 30 minutes "));
        assert!(Why::Idle(240 * MINUTE).note().starts_with("Stopped after 4 hours "));
        assert!(Why::Idle(1440 * MINUTE).note().starts_with("Stopped after a day "));
        assert!(Why::WorkspaceRemoved.note().contains("in the project's folder"));
    }
}
