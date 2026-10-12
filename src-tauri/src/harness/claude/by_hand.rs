//! A Claude Code the reader started by hand (#437): which conversation it is
//! in, and what it says it is doing.
//!
//! Every Claude Code keeps a small file about itself for as long as it runs,
//! `<config dir>/sessions/<pid>.json`, and removes it when it exits. It names
//! the conversation (`sessionId`), the directory the CLI was started in
//! (`cwd`, which is what the transcript's folder is derived from) and what
//! the CLI is doing (`status`).
//!
//! Probed on Claude Code 2.1.296, typed into a shell in a PTY:
//!
//! - the file appears 0.2 to 0.7 s after the CLI starts, before any prompt,
//!   and not while a first-run or trust screen is up. Its first write has no
//!   `status`; `idle` follows within half a second;
//! - `sessionId` is the transcript's name. `--resume <id>` has that id from
//!   the first write and appends to the same file; `-c` is first written
//!   with a fresh id and rewritten to the continued one about 0.1 s later;
//!   `/clear` changes it on the spot, and the new file is there within 0.2 s;
//! - `status` is `idle` at the prompt, `busy` from within 0.1 s of a prompt
//!   being submitted until the turn ends, and `waiting` (with `waitingFor`)
//!   while the CLI asks in its own screen: a permission prompt, a question.
//!   Nothing rewrites the file in between, so its age says nothing;
//! - a CLI that is killed leaves its file behind, and the next one to start
//!   sweeps it.
//!
//! A CLI that keeps no such file is simply not located: its tab is that
//! agent's, with a terminal and nothing in the chat.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::transcript::{locate_in, projects_root};
use crate::session::follow::{Activity, Located};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    pid: u32,
    session_id: String,
    cwd: String,
    #[serde(default)]
    status: Option<String>,
}

fn sessions_dir() -> Option<PathBuf> {
    Some(projects_root()?.parent()?.join("sessions"))
}

/// The file process `pid` keeps, when it is that process's: a file left
/// behind under a pid the system has since given to something else names
/// its own pid, and that has to be this one.
fn read_in(sessions: &Path, pid: u32) -> Option<Session> {
    let text = std::fs::read_to_string(sessions.join(format!("{pid}.json"))).ok()?;
    serde_json::from_str::<Session>(&text).ok().filter(|session| session.pid == pid && uuid::Uuid::parse_str(&session.session_id).is_ok())
}

fn located(projects: &Path, session: &Session) -> Located {
    Located { provider_session_id: session.session_id.clone(), transcript: Some(locate_in(projects, &session.cwd, &session.session_id)) }
}

pub fn locate(pid: u32) -> Option<Located> {
    Some(located(&projects_root()?, &read_in(&sessions_dir()?, pid)?))
}

/// `busy` while a turn runs, `idle` at the prompt, `waiting` while the CLI
/// asks something in its own screen. A word a newer CLI adds is read as
/// idle: a tab that says "Working" for good is worse than one that misses it.
fn activity_of(status: &str) -> Activity {
    match status {
        "busy" => Activity::Busy,
        "waiting" => Activity::Waiting,
        _ => Activity::Idle,
    }
}

pub fn activity(pid: u32) -> Option<Activity> {
    read_in(&sessions_dir()?, pid)?.status.as_deref().map(activity_of)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0a8b6f2e-52d1-4c0a-9d0e-5a4f7d2c1b3e";

    #[test]
    fn a_running_cli_is_found_by_the_file_it_keeps_about_itself() {
        let home = tempfile::tempdir().unwrap();
        let (sessions, projects) = (home.path().join("sessions"), home.path().join("projects"));
        std::fs::create_dir_all(&sessions).unwrap();
        let file = |pid: u32, body: serde_json::Value| std::fs::write(sessions.join(format!("{pid}.json")), body.to_string()).unwrap();
        file(4100, serde_json::json!({ "pid": 4100, "sessionId": ID, "cwd": "/work/app", "status": "busy", "kind": "interactive", "startedAt": 1 }));

        let session = read_in(&sessions, 4100).unwrap();
        assert_eq!(session.status.as_deref().map(activity_of), Some(Activity::Busy));
        // The transcript is under the folder derived from where the CLI was started, whether or not it exists yet.
        assert_eq!(located(&projects, &session), Located { provider_session_id: ID.into(), transcript: Some(projects.join("-work-app").join(format!("{ID}.jsonl"))) });

        // No file, a file under another process's pid, and one that names no conversation are all nobody.
        assert!(read_in(&sessions, 4101).is_none());
        file(4102, serde_json::json!({ "pid": 4100, "sessionId": ID, "cwd": "/work/app" }));
        assert!(read_in(&sessions, 4102).is_none());
        file(4103, serde_json::json!({ "pid": 4103, "sessionId": "../../etc/passwd", "cwd": "/work/app" }));
        assert!(read_in(&sessions, 4103).is_none());
        std::fs::write(sessions.join("4104.json"), "{ not json").unwrap();
        assert!(read_in(&sessions, 4104).is_none());
    }

    #[test]
    fn only_a_running_turn_is_work() {
        assert_eq!(activity_of("busy"), Activity::Busy);
        assert_eq!(activity_of("idle"), Activity::Idle);
        assert_eq!(activity_of("waiting"), Activity::Waiting);
        assert_eq!(activity_of("something-newer"), Activity::Idle);
    }
}
