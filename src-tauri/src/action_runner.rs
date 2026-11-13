//! A project's saved actions (PRO-155 `actions` in projects.json), run as
//! terminal tabs of a local workspace session (PRO-363).
//!
//! An action's run is a shell tab of its session, opened through the same
//! `runtime.pty.spawn` operation as any terminal tab: the runtime gives it the
//! workspace's environment layers (PRO-144) and its port block
//! (TERMINALX_PORT / TERMINALX_PORTS). The tab's pane id names the action, so
//! what runs is read back from the runtime's own list of shells, by the
//! desktop (the Run menu) and by the runtime itself ("Run after setup") alike.
//! A run's exit code is the PTY child's own, heard in its `pty_exit` event.

use std::{collections::HashMap, path::Path, sync::{Arc, OnceLock}, time::{Duration, Instant}};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use crate::{pty::{PtyExit, ShellPane}, session::SessionManager, sink::{EventSink, ListenerId}, store::{self, projects::RepositoryActionEntry}};

/// Sent as `{sessionId, paneId}` once a run's exit code is known. A run's
/// start and close are the tab's own `pty_opened` and `pty_closed`.
pub const EVENT: &str = "action_state_changed";
/// An action's tab is `<session>:action-<run>-<action id as hex>`.
const PANE_PREFIX: &str = "action-";
/// Pane ids are at most 256 bytes; this keeps the hex of the id well inside.
const MAX_ACTION_ID: usize = 96;
/// How long a restart waits for the old run to exit before starting the new
/// one: a server that still holds the workspace's port would fail to listen.
const RESTART_WAIT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State { Running, Exited }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionRun {
    pub session_id: String,
    pub action_id: String,
    /// The tab's title: the action's name unless the reader renamed the tab.
    pub name: String,
    /// The terminal tab's pane id, for the UI to focus.
    pub pane_id: String,
    pub state: State,
    /// The program's exit code once it has exited; none while it runs, when
    /// a signal ended it, or when its exit was not heard here (it exited
    /// before this process was listening).
    pub exit_code: Option<i32>,
    pub started: String,
    pub ended: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub run: ActionRun,
    /// False when a non-concurrent action was already running and `run` is
    /// that running tab: nothing new was started.
    pub started: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunOptions {
    /// Stop a running non-concurrent run and start a new one in its place.
    pub restart: bool,
}

/// The owner of the terminals: the runtime's own [`SessionManager`], or the
/// desktop's client of it. Both open, list and close tabs with the runtime's
/// `runtime.pty.*` operations.
pub trait Host {
    fn spawn(&self, pane: &str, cwd: &str, command: &str, title: &str) -> Result<()>;
    /// Every session's shell tabs, including ones whose program has exited.
    fn shells(&self) -> Result<Vec<ShellPane>>;
    fn kill(&self, pane: &str) -> Result<()>;
}

impl Host for SessionManager {
    fn spawn(&self, pane: &str, cwd: &str, command: &str, title: &str) -> Result<()> {
        crate::local_runtime::calls::execute(self, self.sink(), "runtime.pty.spawn",
            json!({"id": pane, "cwd": cwd, "cols": 120, "rows": 30, "command": command, "title": title}))?;
        Ok(())
    }
    fn shells(&self) -> Result<Vec<ShellPane>> {
        Ok(serde_json::from_value(crate::local_runtime::calls::execute(self, self.sink(), "runtime.pty.shells", json!({}))?)?)
    }
    fn kill(&self, pane: &str) -> Result<()> {
        crate::local_runtime::calls::execute(self, self.sink(), "runtime.pty.kill", json!({"id": pane}))?;
        Ok(())
    }
}

#[cfg(unix)]
impl Host for crate::local_runtime::terminals::Terminals {
    fn spawn(&self, pane: &str, cwd: &str, command: &str, title: &str) -> Result<()> {
        crate::local_runtime::terminals::Terminals::spawn(self, pane, cwd, 120, 30, Some(command), Some(title))
    }
    fn shells(&self) -> Result<Vec<ShellPane>> { self.all_shells() }
    fn kill(&self, pane: &str) -> Result<()> { crate::local_runtime::terminals::Terminals::kill(self, pane) }
}

struct Exit { code: Option<i32>, ended: String }

/// Exits heard for action panes, by pane id.
fn exits() -> &'static parking_lot::Mutex<HashMap<String, Exit>> {
    static EXITS: OnceLock<parking_lot::Mutex<HashMap<String, Exit>>> = OnceLock::new();
    EXITS.get_or_init(Default::default)
}

/// Serializes "is it running?" with the launch that follows, so two quick
/// clicks on a non-concurrent action start one tab.
static LAUNCH: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Record the exit code of every action tab whose `pty_exit` reaches `sink`,
/// and tell the windows with [`EVENT`]. The desktop hears every runtime
/// event, so it learns the exits of the runs the runtime started too.
pub fn observe(sink: Arc<dyn EventSink>) -> ListenerId {
    let notify = sink.clone();
    sink.listen("pty_exit", Box::new(move |raw| {
        let Ok(exit) = serde_json::from_str::<PtyExit>(raw) else { return };
        let Some((session, _)) = parse_pane(&exit.id) else { return };
        let session = session.to_string();
        exits().lock().insert(exit.id.clone(), Exit { code: exit.code, ended: store::index::now() });
        let sink = notify.clone();
        // Not from inside the sink's own dispatch.
        let _ = std::thread::Builder::new().name("action-exit".into()).spawn(move || {
            sink.emit(EVENT, &json!({"sessionId": session, "paneId": exit.id}));
        });
    }))
}

fn pane_id(session: &str, action: &str) -> Result<String> {
    if action.is_empty() || action.len() > MAX_ACTION_ID { bail!("This action's id is too long to run it"); }
    let hex: String = action.bytes().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{session}:{PANE_PREFIX}{}-{hex}", uuid::Uuid::now_v7().simple()))
}

/// The session and action id an action tab's pane id names.
fn parse_pane(pane: &str) -> Option<(&str, String)> {
    let (session, rest) = pane.split_once(':')?;
    let (_, hex) = rest.strip_prefix(PANE_PREFIX)?.split_once('-')?;
    if hex.is_empty() || hex.len() % 2 != 0 { return None }
    let bytes = (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok()).collect::<Option<Vec<_>>>()?;
    Some((session, String::from_utf8(bytes).ok()?))
}

/// The shell command line the tab runs: the action's command, run by the
/// reader's shell as a script of its own, so that `a && b` or `cd x; y` work
/// whole (a terminal tab's command is `exec`ed by the login shell) and the
/// tab's program exits with the command's own status. `env` adds what a
/// setup script is given (workspace path, repository root, branch, session)
/// on top of the tab's own environment layers and port block.
fn command_line(command: &str, env: &[(String, String)]) -> String {
    let shell = crate::pty::shell();
    let posix = ["zsh", "bash", "fish", "sh", "dash", "ksh"].iter().any(|name| Path::new(&shell).file_name().is_some_and(|file| file == *name));
    let shell = if posix { shell } else { "/bin/sh".to_string() };
    let assignments: Vec<String> = env.iter().map(|(name, value)| quote(&format!("{name}={value}"))).collect();
    format!("env {} {} -c {}", assignments.join(" "), quote(&shell), quote(command))
}

/// Single-quoted for POSIX shells, and read the same way by fish.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// A session's runs, oldest first: one per action tab still open.
pub fn states(host: &dyn Host, session: &str) -> Result<Vec<ActionRun>> {
    let shells = host.shells()?;
    let mut exits = exits().lock();
    // Exits of tabs that have since been closed are no longer anyone's.
    let prefix = format!("{session}:{PANE_PREFIX}");
    exits.retain(|pane, _| !pane.starts_with(&prefix) || shells.iter().any(|shell| &shell.id == pane));
    Ok(shells.into_iter().filter_map(|shell| {
        let (owner, action_id) = parse_pane(&shell.id)?;
        if owner != session { return None }
        let exit = exits.get(&shell.id);
        // Exited once its program is gone, even before its exit is heard.
        let exited = shell.exited || exit.is_some();
        Some(ActionRun {
            session_id: session.to_string(), action_id, name: shell.title.clone().unwrap_or_default(), pane_id: shell.id,
            state: if exited { State::Exited } else { State::Running },
            exit_code: exit.and_then(|exit| exit.code), started: shell.created, ended: exit.map(|exit| exit.ended.clone()),
        })
    }).collect())
}

fn project_actions(project: &str) -> Result<Vec<RepositoryActionEntry>> {
    let canonical = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let (projects, _) = store::projects::list()?;
    let project = projects.into_iter().find(|p| canonical(Path::new(&p.path)) == canonical(Path::new(project)))
        .context("This session's project is not saved in TerminalX")?;
    Ok(project.actions)
}

/// Start `action_id` of the session's project in a new terminal tab, or, for
/// a non-concurrent action already running, return that tab (or replace it
/// when `options.restart`).
pub fn run(host: &dyn Host, session: &str, action_id: &str, options: RunOptions) -> Result<RunOutcome> {
    let entry = store::index::get(session)?;
    if entry.worktree_removed { bail!("This workspace is no longer available"); }
    // Hidden actions are only left out of menus; the action itself still runs.
    let action = project_actions(&entry.project_path)?.into_iter().find(|a| a.id == action_id)
        .context("This project has no such saved action")?;
    let _launch = LAUNCH.lock();
    if !action.concurrent {
        let running = states(host, session)?.into_iter().find(|r| r.action_id == action.id && r.state == State::Running);
        if let Some(running) = running {
            if !options.restart { return Ok(RunOutcome { run: running, started: false }) }
            host.kill(&running.pane_id)?;
            let deadline = Instant::now() + RESTART_WAIT;
            while !exits().lock().contains_key(&running.pane_id) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    let pane = pane_id(session, &action.id)?;
    let mut env = crate::archive_script::environment(Path::new(&entry.project_path), Path::new(&entry.cwd), Some(&entry));
    env.push(("TERMINALX_ACTION_ID".into(), action.id.clone()));
    host.spawn(&pane, &entry.cwd, &command_line(&action.command, &env), &action.name)
        .with_context(|| format!("Could not start \"{}\"", action.name))?;
    let run = states(host, session)?.into_iter().find(|r| r.pane_id == pane).unwrap_or_else(|| ActionRun {
        session_id: session.to_string(), action_id: action.id.clone(), name: action.name.clone(), pane_id: pane.clone(),
        state: State::Running, exit_code: None, started: store::index::now(), ended: None,
    });
    Ok(RunOutcome { run, started: true })
}

/// The workspace's setup script has succeeded: start its project's
/// "Run after setup" actions, in saved order. Failures are logged, never
/// reported as a setup failure.
pub fn after_setup(manager: &SessionManager, session: &str) {
    let actions = store::index::get(session).and_then(|entry| project_actions(&entry.project_path));
    let actions = match actions { Ok(actions) => actions, Err(error) => { log::warn!("Run after setup for {session}: {error:#}"); return } };
    for action in actions.into_iter().filter(|a| a.run_after_setup) {
        if let Err(error) = run(manager, session, &action.id, RunOptions::default()) {
            log::warn!("Run after setup \"{}\" for {session}: {error:#}", action.name);
        }
    }
}

#[cfg(all(test, unix))]
#[path = "action_runner_tests.rs"]
mod tests;
