//! Local archive hooks. Only scripts explicitly saved in the project store run.
//! A failed run grants a short-lived, single-use receipt, bound to its checkout
//! and script. A force-delete flag is never consent to skip a failed hook.
use std::{collections::{HashMap, HashSet}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, Weak}, time::{Duration, Instant}};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use crate::{pty::{PaneSpec, PtyExit, Terminals}, sink::EventSink, store::{index::SessionEntry, projects}};

pub const FAILURE_PREFIX: &str = "ARCHIVE_SCRIPT_FAILED:";
const TIMEOUT: Duration = Duration::from_secs(300);
// A bulk run can contain many five-minute timeouts. Consent remains usable
// when that run finally presents all failures together.
const RECEIPT_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Copy)]
pub struct Runner<'a> {
    pub terminals: &'a Arc<Terminals>,
    pub sink: &'a Arc<dyn EventSink>,
    pub unattended: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub token: String,
    pub pane: String,
    pub code: Option<i32>,
    pub timed_out: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
    #[serde(default)]
    pub sessions_stopped: bool,
}

impl Failure {
    pub fn message(&self) -> String {
        format!("Archive script failed (exit {}). Remove anyway?{}", self.code.map_or("unknown".into(), |code| code.to_string()),
            if self.timed_out { " The script timed out after 5 minutes." } else { "" })
            + if self.sessions_stopped { " Its sessions are stopped." } else { "" }
    }
    pub fn from_error(error: &str) -> Option<Self> {
        serde_json::from_str(error.strip_prefix(FAILURE_PREFIX)?).ok()
    }
}

struct Receipt { path: PathBuf, project: PathBuf, identity: String, script: String, pane: String, terminals: Weak<Terminals>, at: Instant }
fn receipts() -> &'static Mutex<HashMap<String, Receipt>> {
    static RECEIPTS: OnceLock<Mutex<HashMap<String, Receipt>>> = OnceLock::new();
    RECEIPTS.get_or_init(Default::default)
}

fn reap_receipts(now: Instant) {
    receipts().lock().unwrap().retain(|_, receipt| {
        if now.saturating_duration_since(receipt.at) < RECEIPT_LIFETIME { return true }
        if let Some(terminals) = receipt.terminals.upgrade() { terminals.kill(&receipt.pane); }
        false
    });
}
fn remember(runner: Runner<'_>, project: PathBuf, path: PathBuf, identity: String, script: String, failure: &Failure) {
    static REAPER: OnceLock<()> = OnceLock::new();
    REAPER.get_or_init(|| { std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        reap_receipts(Instant::now());
    }); });
    let mut receipts = receipts().lock().unwrap();
    // Repeated manual attempts keep one log per checkout, not one per click.
    receipts.retain(|_, receipt| {
        if receipt.path != path { return true }
        if let Some(terminals) = receipt.terminals.upgrade() { terminals.kill(&receipt.pane); }
        false
    });
    receipts.insert(failure.token.clone(), Receipt { project, path, identity, script, pane: failure.pane.clone(), terminals: Arc::downgrade(runner.terminals), at: Instant::now() });
}

/// A persisted automatic attempt is specific to this checkout, head and script.
pub(crate) fn fingerprint(path: &Path, script: &str) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for field in [checkout_identity(path)?, crate::git::head_commit(path).context("The workspace has no HEAD")?, script.to_string()] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn canonical(path: &Path) -> PathBuf { std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()) }
fn checkout_identity(path: &Path) -> Result<String> {
    let metadata = std::fs::metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    Ok(format!("{:?}", metadata.created()?))
}

fn removing() -> &'static Mutex<HashSet<PathBuf>> {
    static REMOVING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    REMOVING.get_or_init(Default::default)
}
pub struct RemovalLease(PathBuf);
impl RemovalLease {
    pub fn acquire(path: &Path) -> Result<Self> {
        let path = canonical(path);
        anyhow::ensure!(removing().lock().unwrap().insert(path.clone()), "This workspace is already being removed.");
        Ok(Self(path))
    }
}
impl Drop for RemovalLease {
    fn drop(&mut self) { removing().lock().unwrap().remove(&self.0); }
}

/// Called inside the removal fence, before the final Git/session checks.
pub fn before_removal(project: &Path, path: &Path, sessions: &[SessionEntry], confirmed: Option<&str>, retry: Option<&str>, runner: Option<Runner<'_>>, started: &dyn Fn()) -> Result<bool> {
    anyhow::ensure!(confirmed.is_none() || retry.is_none(), "Choose either retrying the archive script or removing anyway.");
    let script = projects::scripts(project)?.archive;
    if script.trim().is_empty() || !path.exists() {
        // A cleared hook no longer needs consent. Release its matching old log
        // immediately rather than retaining it until expiry.
        if let Some(token) = confirmed.or(retry) {
            let project = canonical(project);
            let path = canonical(path);
            let receipt = {
                let mut pending = receipts().lock().unwrap();
                if pending.get(token).is_some_and(|receipt| receipt.project == project && receipt.path == path) {
                    pending.remove(token)
                } else { None }
            };
            if let Some(receipt) = receipt {
                if let Some(terminals) = receipt.terminals.upgrade() { terminals.kill(&receipt.pane); }
            }
        }
        return Ok(false)
    }
    // Never run commands in an arbitrary path supplied to a forced removal.
    let project = canonical(project);
    let path = canonical(path);
    let identity = checkout_identity(&path)?;
    let listed = crate::workspaces::list(&project)?;
    anyhow::ensure!(listed.iter().any(|tree| !tree.is_main && canonical(Path::new(&tree.path)) == path), "Not a removable worktree of this repository.");
    if let Some(token) = confirmed.or(retry) {
        let receipt = receipts().lock().unwrap().remove(token);
        if let Some(receipt) = &receipt {
            if let Some(terminals) = receipt.terminals.upgrade() { terminals.kill(&receipt.pane); }
        }
        anyhow::ensure!(receipt.is_some_and(|receipt| receipt.path == path && receipt.project == project && receipt.script == script && receipt.identity == identity && receipt.at.elapsed() < RECEIPT_LIFETIME),
            "The archive failure confirmation expired or the script changed. Run removal again.");
        if confirmed.is_some() { return Ok(true) }
    }
    let runner = runner.context("This repository has an archive script. Remove the workspace from this computer's workspace dialog to run it first.")?;
    if runner.unattended {
        anyhow::ensure!(crate::merged_cleanup::archive_attempt_matches(&project, &path, &script)?, "The workspace or script changed before its automatic archive run. Nothing was run.");
    }
    // A recorded unattended failure is shown for explicit consent, even after
    // a runtime restart. It never reruns merely because a dialog was opened.
    if !runner.unattended && retry.is_none() {
        if let Some(mut failure) = crate::merged_cleanup::recorded_archive_failure(&project, &path, &script)? {
            failure.token = uuid::Uuid::new_v4().to_string();
            failure.sessions_stopped |= !sessions.is_empty();
            remember(runner, project, path, identity, script, &failure);
            bail!("{FAILURE_PREFIX}{}", serde_json::to_string(&failure)?);
        }
    }
    let session = sessions.iter().find(|session| canonical(Path::new(&session.cwd)) == path);
    let env = environment(&project, &path, session);
    let failure = run(runner, &path, &script, &env, TIMEOUT, started)?;
    if let Some(mut failure) = failure {
        failure.sessions_stopped = !sessions.is_empty();
        if !runner.unattended { remember(runner, project, path, identity, script, &failure); }
        bail!("{FAILURE_PREFIX}{}", serde_json::to_string(&failure)?);
    }
    Ok(true)
}

fn environment(project: &Path, path: &Path, session: Option<&SessionEntry>) -> Vec<(String, String)> {
    // The PTY applies Settings user/repository variables over the runtime
    // environment, then the login-shell PATH and these lifecycle variables.
    // Provider credentials and per-agent hook tokens belong only to the agent.
    let mut env = vec![
        ("TERMINALX_WORKSPACE_PATH".into(), path.to_string_lossy().into_owned()),
        ("TERMINALX_REPO_ROOT".into(), project.to_string_lossy().into_owned()),
        ("TERMINALX_BRANCH".into(), crate::git::current_branch(path).unwrap_or_default()),
    ];
    if let Some(session) = session { env.push(("TERMINALX_SESSION_ID".into(), session.id.clone())); }
    env
}

fn run(runner: Runner<'_>, path: &Path, script: &str, env: &[(String, String)], timeout: Duration, started: &dyn Fn()) -> Result<Option<Failure>> {
    let id = format!("archive:{}", uuid::Uuid::new_v4());
    // Literal argv avoids the user's shell syntax altogether (including nu).
    let mut file = tempfile::Builder::new().prefix("terminalx-archive-").suffix(".sh").tempfile()?;
    use std::io::Write;
    file.write_all(script.as_bytes())?;
    file.flush()?;
    let (send, recv) = std::sync::mpsc::channel();
    let watched = id.clone();
    let listener = runner.sink.listen("pty_exit", Box::new(move |raw| {
        if let Ok(exit) = serde_json::from_str::<PtyExit>(raw) {
            if exit.id == watched { let _ = send.send(exit.code); }
        }
    }));
    let spawned = runner.terminals.spawn_program(runner.sink.clone(), &id, PaneSpec { cwd: &path.to_string_lossy(), cols: 100, rows: 24, command: None, env }, std::ffi::OsStr::new("/bin/sh"), &[file.path().as_os_str()], started);
    if let Err(error) = spawned { runner.sink.unlisten(listener); return Err(error) }
    struct PaneCleanup<'a> { terminals: &'a Terminals, id: &'a str, keep: bool }
    impl Drop for PaneCleanup<'_> { fn drop(&mut self) { if !self.keep { self.terminals.kill(self.id); } } }
    let mut pane = PaneCleanup { terminals: runner.terminals, id: &id, keep: false };
    if !runner.unattended { runner.sink.emit("archive_script_started", &serde_json::json!({"path": path, "pane": id})); }
    let exit = recv.recv_timeout(timeout);
    runner.sink.unlisten(listener);
    let timed_out = matches!(exit, Err(std::sync::mpsc::RecvTimeoutError::Timeout));
    // Even successful scripts may leave children behind. Wait for the whole
    // owned group before permitting removal, while preserving the terminal.
    anyhow::ensure!(runner.terminals.stop_keep_output(&id, Duration::from_secs(5)), "The archive script's processes could not be stopped. Nothing was removed.");
    let code = if timed_out { Some(124) } else { exit.ok().flatten() };
    if code == Some(0) { return Ok(None) }
    let log = runner.unattended.then(|| {
        let bytes = runner.terminals.read_output(&id).unwrap_or_default();
        let tail = bytes.len().saturating_sub(32 * 1024);
        String::from_utf8_lossy(&bytes[tail..]).into_owned()
    });
    pane.keep = !runner.unattended;
    Ok(Some(Failure { token: uuid::Uuid::new_v4().to_string(), pane: id.clone(), code, timed_out, log, sessions_stopped: false }))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn runtime() -> (Arc<Terminals>, Arc<dyn EventSink>) {
        (Arc::new(Terminals::new()), Arc::new(crate::sink::BroadcastSink::new(64)))
    }

    #[test]
    fn preserves_exit_codes_working_directory_environment_and_terminal_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = canonical(dir.path());
        let (terminals, sink) = runtime();
        let runner = Runner { terminals: &terminals, sink: &sink, unattended: false };
        let env = vec![("PRO149_VALUE".into(), "spaces ' and $literal".into())];
        let failure = run(runner, &path, "printf '%s\\n' \"$PWD\" \"$PRO149_VALUE\"; exit 17", &env, Duration::from_secs(10), &|| {}).unwrap().unwrap();
        assert_eq!(failure.code, Some(17));
        assert!(!failure.timed_out);
        let output = String::from_utf8_lossy(&terminals.read_output(&failure.pane).unwrap()).into_owned();
        assert!(output.contains(path.to_str().unwrap()), "{output}");
        assert!(output.contains("spaces ' and $literal"), "{output}");
        assert!(run(runner, &path, "exit 0", &[], Duration::from_secs(10), &|| {}).unwrap().is_none());
        terminals.kill_all();
    }

    #[test]
    fn timeout_stops_the_process_group_and_keeps_the_log() {
        for unattended in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (terminals, sink) = runtime();
            let start = Instant::now();
            let failed = run(Runner { terminals: &terminals, sink: &sink, unattended }, dir.path(), "echo before-timeout; sleep 60 & wait", &[], Duration::from_secs(2), &|| {}).unwrap().unwrap();
            assert_eq!(failed.code, Some(124));
            assert!(failed.timed_out);
            assert!(start.elapsed() < Duration::from_secs(12));
            if unattended {
                assert!(terminals.panes().is_empty());
                assert!(failed.log.unwrap().contains("before-timeout"));
            } else {
                assert!(terminals.stop_keep_output(&failed.pane, Duration::from_secs(1)));
                assert!(String::from_utf8_lossy(&terminals.read_output(&failed.pane).unwrap()).contains("before-timeout"));
            }
            terminals.kill_all();
        }
    }

    #[test]
    fn expired_manual_receipts_close_the_terminal_without_another_hook() {
        let dir = tempfile::tempdir().unwrap();
        let (terminals, sink) = runtime();
        let runner = Runner { terminals: &terminals, sink: &sink, unattended: false };
        let failure = run(runner, dir.path(), "exit 4", &[], Duration::from_secs(10), &|| {}).unwrap().unwrap();
        remember(runner, dir.path().into(), dir.path().into(), "identity".into(), "exit 4".into(), &failure);
        assert_eq!(terminals.panes().len(), 1);
        receipts().lock().unwrap().get_mut(&failure.token).unwrap().at = Instant::now() - RECEIPT_LIFETIME - Duration::from_secs(1);
        reap_receipts(Instant::now());
        assert!(terminals.panes().is_empty());
        assert!(!receipts().lock().unwrap().contains_key(&failure.token));
    }

    #[test]
    fn a_workspace_has_only_one_removal_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let lease = RemovalLease::acquire(dir.path()).unwrap();
        assert!(RemovalLease::acquire(dir.path()).is_err());
        drop(lease);
        assert!(RemovalLease::acquire(dir.path()).is_ok());
    }
}
