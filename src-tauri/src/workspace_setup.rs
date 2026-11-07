//! Per-repository setup, owned by the runtime just like an agent's PTY.
//! The creation path records the attempt before publishing the session. Opening
//! an existing session never creates an attempt, and only an explicit rerun
//! replaces one that was already started (including an interrupted run).

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{pty, session::SessionManager, store};
use crate::store::index::SessionEntry;

pub const CONFIG_FILE: &str = "terminalx.json";
const EVENT: &str = "workspace_setup_changed";
static RUN_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
#[cfg(any(test, feature = "desktop"))]
static CONFIG_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub session_id: String,
    pub pane_id: String,
    pub command: String,
    pub status: Status,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    #[serde(default, skip_serializing)]
    log: String,
    /// A completed run remains readable after its PTY owner has restarted.
    #[serde(default)]
    pub has_pane: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Status { Pending, Running, Succeeded, Failed }

fn config(root: &Path) -> Result<Value> {
    use std::io::Read;
    let path = root.join(CONFIG_FILE);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(error).with_context(|| format!("Read {}", path.display())),
    };
    if !metadata.is_file() { bail!("{CONFIG_FILE} must be a regular file"); }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)?.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 { bail!("{CONFIG_FILE} is too large"); }
    let value: Value = serde_json::from_slice(&bytes).with_context(|| format!("Parse {}", path.display()))?;
    setup_script(&value)?;
    Ok(value)
}

fn setup_script(value: &Value) -> Result<Option<String>> {
    if !value.is_object() { bail!("{CONFIG_FILE} must contain a JSON object"); }
    let Some(scripts) = value.get("scripts") else { return Ok(None) };
    if !scripts.is_object() { bail!("scripts must be an object"); }
    let Some(setup) = scripts.get("setup") else { return Ok(None) };
    let setup = setup.as_str().context("scripts.setup must be a string")?;
    if setup.contains('\0') { bail!("scripts.setup cannot contain NUL"); }
    Ok((!setup.trim().is_empty()).then(|| setup.to_owned()))
}

pub fn read_script(project: &str) -> Result<Option<String>> {
    let root = store::projects::canonical_directory(project)?;
    setup_script(&config(Path::new(&root))?)
}

#[cfg(any(test, feature = "desktop"))]
pub fn save_script(project: &str, command: &str) -> Result<()> {
    let _lock = CONFIG_LOCK.lock();
    let root = store::projects::canonical_directory(project)?;
    store::projects::refuse_mirror(&root)?;
    let path = Path::new(&root).join(CONFIG_FILE);
    if path.symlink_metadata().is_ok_and(|meta| meta.file_type().is_symlink()) {
        bail!("Cannot edit a symlinked {CONFIG_FILE}");
    }
    let mut value = config(Path::new(&root))?;
    if value.get("scripts").is_none() { value["scripts"] = json!({}); }
    value["scripts"]["setup"] = json!(command);
    setup_script(&value)?;
    if serde_json::to_vec_pretty(&value)?.len() > 1024 * 1024 { bail!("{CONFIG_FILE} is too large"); }
    store::write_json(&path, &value)
}

fn path(session: &str) -> Result<std::path::PathBuf> {
    // Callers resolve this id in the index before using it as a path.
    Ok(store::sessions_dir()?.join(session).join("workspace-setup.json"))
}

fn read(session: &str) -> Result<Option<Setup>> { store::read_json(&path(session)?) }

fn save(setup: &Setup) -> Result<()> {
    // Logs live beside the status and are not broadcast with every update.
    let mut value = serde_json::to_value(setup)?;
    value["log"] = json!(setup.log);
    store::session_dir(&setup.session_id)?;
    store::write_json(&path(&setup.session_id)?, &value)
}

/// Only called by creation, and only for a newly made worktree.
pub fn prepare(entry: &SessionEntry) -> Result<()> {
    if entry.worktree_name.is_none() { return Ok(()) }
    let (command, error) = match read_script(&entry.project_path) {
        Ok(Some(command)) => (command, None),
        Ok(None) => return Ok(()),
        Err(error) => (String::new(), Some(format!("{error:#}"))),
    };
    save(&Setup {
        session_id: entry.id.clone(), pane_id: String::new(), command,
        status: if error.is_some() { Status::Failed } else { Status::Pending },
        exit_code: None, error, log: String::new(), has_pane: false,
    })
}

pub fn environment(entry: &SessionEntry) -> Vec<(String, String)> {
    vec![
        ("TERMINALX_WORKSPACE_PATH".into(), entry.cwd.clone()),
        ("TERMINALX_REPO_ROOT".into(), entry.project_path.clone()),
        ("TERMINALX_BRANCH".into(), entry.branch.clone().unwrap_or_default()),
    ]
}

fn publish(manager: &SessionManager, setup: &Setup) -> Result<()> {
    save(setup)?;
    manager.sink().emit(EVENT, setup);
    Ok(())
}

/// Admission and the run lock cover the check and launch, across every window.
pub fn start(manager: &SessionManager, session: &str, rerun: bool) -> Result<Option<Setup>> {
    let _admission = crate::issue_pipeline::admission::lock();
    manager.accepting_work()?;
    crate::issue_pipeline::admission::open(session, None)?;
    let entry = store::index::get(session)?;
    let _run = RUN_LOCK.lock();
    let Some(mut setup) = read(session)? else { return Ok(None) };
    if !rerun && setup.status != Status::Pending {
        let setup = view(manager, setup)?;
        manager.sink().emit(EVENT, &setup);
        return Ok(Some(setup));
    }
    if manager.terminals().is_running(&setup.pane_id) || manager.terminals().is_busy(&setup.pane_id) {
        bail!("Setup is already running");
    }
    if entry.worktree_removed || entry.worktree_name.is_none() || entry.cwd == entry.project_path {
        bail!("The setup workspace is no longer available");
    }
    let script = if rerun { read_script(&entry.project_path) } else { Ok(Some(setup.command.clone())) };
    let command = match script {
        Ok(Some(command)) => command,
        Ok(None) => bail!("This repository no longer has a setup script"),
        Err(error) => {
            setup.status = Status::Failed;
            setup.error = Some(format!("{error:#}"));
            publish(manager, &setup)?;
            return Ok(Some(setup));
        }
    };
    if !setup.pane_id.is_empty() { manager.terminals().kill(&setup.pane_id); }
    setup.pane_id = format!("{session}:workspace-setup-{}", uuid::Uuid::now_v7());
    setup.command = command.clone();
    setup.status = Status::Running;
    setup.exit_code = None;
    setup.error = None;
    setup.log.clear();
    setup.has_pane = true;
    publish(manager, &setup)?;
    // PaneSpec commands are exec'd by the login shell. A separate POSIX shell
    // preserves multiline scripts, &&, exports, and the script's exit status.
    #[cfg(not(windows))]
    let command = format!("/bin/sh -c '{}'", command.replace('\'', "'\\''"));
    let result = manager.terminals().spawn(manager.sink().clone(), &setup.pane_id, pty::PaneSpec {
        cwd: &entry.cwd, cols: 100, rows: 24, command: Some(&command), env: &environment(&entry),
    });
    if let Err(error) = result {
        setup.status = Status::Failed;
        setup.has_pane = false;
        setup.error = Some(format!("{error:#}"));
        publish(manager, &setup)?;
    }
    Ok(Some(setup))
}

fn view(manager: &SessionManager, mut setup: Setup) -> Result<Setup> {
    setup.has_pane = manager.terminals().shell(&setup.pane_id).is_some();
    if setup.status == Status::Running && !setup.has_pane {
        setup.status = Status::Failed;
        setup.error = Some("Setup was interrupted. Rerun to try again.".into());
        publish(manager, &setup)?;
    }
    Ok(setup)
}

pub fn list(manager: &SessionManager) -> Result<Vec<Setup>> {
    let _run = RUN_LOCK.lock();
    let mut setups = Vec::new();
    for entry in store::index::load()? {
        if let Some(setup) = read(&entry.id)? { setups.push(view(manager, setup)?); }
    }
    Ok(setups)
}

pub fn log(manager: &SessionManager, session: &str, pane: &str) -> Result<String> {
    let _run = RUN_LOCK.lock();
    store::index::get(session)?;
    let setup = read(session)?.context("This workspace has no setup run")?;
    if setup.pane_id != pane { bail!("Setup has been rerun. Open the current log and try again."); }
    let output = manager.terminals().read_output(&setup.pane_id)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or(setup.log);
    Ok(format!("$ {}\n{}{}", setup.command, output, setup.error.map(|error| format!("\n{error}")).unwrap_or_default()))
}

pub fn finished(manager: &SessionManager, exit: &pty::PtyExit) {
    let Some((session, pane)) = exit.id.split_once(':') else { return };
    if !pane.starts_with("workspace-setup-") { return }
    let result = (|| -> Result<()> {
        let _run = RUN_LOCK.lock();
        // Deletion may have removed this session while the process was exiting.
        if store::index::get(session).is_err() { return Ok(()) }
        let Some(mut setup) = read(session)? else { return Ok(()) };
        if setup.pane_id != exit.id || setup.status != Status::Running { return Ok(()) }
        setup.status = if exit.code == Some(0) { Status::Succeeded } else { Status::Failed };
        setup.exit_code = exit.code;
        setup.has_pane = manager.terminals().shell(&exit.id).is_some();
        setup.log = manager.terminals().read_output(&exit.id).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
        publish(manager, &setup)
    })();
    if let Err(error) = result { log::warn!("Save workspace setup result: {error:#}"); }
}

pub fn follow_creations(manager: &SessionManager) {
    let owner = manager.clone();
    manager.sink().listen("session_created", Box::new(move |payload| {
        let Ok(entry) = serde_json::from_str::<SessionEntry>(payload) else { return };
        if entry.worktree_name.is_none() { return }
        let owner = owner.clone();
        // The event can be emitted under another lifecycle lock. Launch outside
        // its callback, without delaying the agent's first turn.
        std::thread::spawn(move || {
            start_pending(&owner, &entry.id);
        });
    }));
    // Creation was saved but the previous owner ended before launching it.
    // Running/finished attempts are deliberately never replayed here.
    let pending: Vec<_> = store::index::load().unwrap_or_default().into_iter()
        .filter(|entry| matches!(read(&entry.id), Ok(Some(Setup { status: Status::Pending, .. }))))
        .map(|entry| entry.id).collect();
    if !pending.is_empty() {
        let owner = manager.clone();
        std::thread::spawn(move || {
            for id in pending {
                start_pending(&owner, &id);
            }
        });
    }
}

fn start_pending(manager: &SessionManager, session: &str) {
    if let Err(error) = start(manager, session, false) {
        log::warn!("Start workspace setup: {error:#}");
        let _run = RUN_LOCK.lock();
        if store::index::get(session).is_err() { return }
        if let Ok(Some(mut setup)) = read(session) {
            if setup.status == Status::Pending {
                setup.status = Status::Failed;
                setup.error = Some(format!("{error:#}"));
                if let Err(error) = publish(manager, &setup) { log::warn!("Save setup launch failure: {error:#}"); }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::{sync::Arc, time::{Duration, Instant}};

    fn entry(id: &str, root: &Path, cwd: &Path) -> SessionEntry {
        serde_json::from_value(json!({
            "id": id, "projectPath": root, "cwd": cwd, "title": id,
            "worktreeName": "setup", "branch": "raccoon/setup's-branch",
            "created": "", "modified": "", "tabs": [],
        })).unwrap()
    }

    #[test]
    fn workspace_environment_is_passed_as_values_not_shell_source() {
        let entry = entry("setup", Path::new("/repo root/'$x"), Path::new("/work tree/$(false)"));
        assert_eq!(environment(&entry), vec![
            ("TERMINALX_WORKSPACE_PATH".into(), "/work tree/$(false)".into()),
            ("TERMINALX_REPO_ROOT".into(), "/repo root/'$x".into()),
            ("TERMINALX_BRANCH".into(), "raccoon/setup's-branch".into()),
        ]);
        let mut detached = entry;
        detached.branch = None;
        assert_eq!(environment(&detached)[2].1, "");
    }

    #[test]
    fn parses_optional_setup_without_claiming_other_repo_fields() {
        for value in [json!({}), json!({"scripts": {}}), json!({"scripts": {"setup": " \n"}})] {
            assert_eq!(setup_script(&value).unwrap(), None);
        }
        assert_eq!(setup_script(&json!({"scripts": {"setup": "bun install\ncp ../.env .env", "run": "bun dev"}, "future": true})).unwrap().as_deref(), Some("bun install\ncp ../.env .env"));
        for value in [json!(null), json!([]), json!({"scripts": []}), json!({"scripts": {"setup": false}}), json!({"scripts": {"setup": "a\0b"}})] {
            assert!(setup_script(&value).is_err(), "{value}");
        }
    }

    #[test]
    fn settings_preserve_unknown_fields_and_refuse_corrupt_files() {
        let _home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(read_script(root).unwrap(), None);
        std::fs::write(dir.path().join(CONFIG_FILE), r#"{"scripts":{"run":"bun dev"},"future":42}"#).unwrap();
        save_script(root, "bun install").unwrap();
        let value = config(dir.path()).unwrap();
        assert_eq!(value["scripts"]["run"], "bun dev");
        assert_eq!(value["future"], 42);
        assert_eq!(read_script(root).unwrap().as_deref(), Some("bun install"));
        std::fs::write(dir.path().join(CONFIG_FILE), "broken").unwrap();
        assert!(save_script(root, "anything").is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap(), "broken");
    }

    #[cfg(unix)]
    #[test]
    fn setup_runs_once_and_rerun_reports_failure_with_its_log() {
        let _home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let cwd = root.join("work tree ' $name");
        std::fs::create_dir(&cwd).unwrap();
        let entry = entry("workspace-setup-test", &root, &cwd);
        store::index::save(std::slice::from_ref(&entry)).unwrap();
        let manager = SessionManager::new(
            Arc::new(crate::sink::BroadcastSink::new(64)), Arc::new(crate::sink::NoObserver),
            Arc::new(crate::harness::host::Host::new()), Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap(),
        );
        // Only the exit listener, so this test explicitly controls each start.
        let owner = manager.clone();
        manager.sink().listen("pty_exit", Box::new(move |payload| {
            finished(&owner, &serde_json::from_str(payload).unwrap());
        }));
        let wait = |status| {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if read(&entry.id).unwrap().is_some_and(|run| run.status == status) { break }
                assert!(Instant::now() < deadline, "setup did not finish");
                std::thread::sleep(Duration::from_millis(10));
            }
        };

        // No script means no record or pane. Existing checkouts are not prepared.
        prepare(&entry).unwrap();
        assert!(start(&manager, &entry.id, false).unwrap().is_none());
        save_script(root.to_str().unwrap(), "printf '%s\\n' \"$TERMINALX_WORKSPACE_PATH\" \"$TERMINALX_REPO_ROOT\" \"$TERMINALX_BRANCH\"\nprintf run >> count\nprintf 'last line\\n'").unwrap();
        let mut existing = entry.clone();
        existing.worktree_name = None;
        prepare(&existing).unwrap();
        assert!(read(&entry.id).unwrap().is_none());
        prepare(&entry).unwrap();
        start(&manager, &entry.id, false).unwrap();
        wait(Status::Succeeded);
        let first = read(&entry.id).unwrap().unwrap();
        let output = log(&manager, &entry.id, &first.pane_id).unwrap();
        for (_, value) in environment(&entry) { assert!(output.contains(&value), "{output}"); }
        assert!(output.contains("last line"));
        start(&manager, &entry.id, false).unwrap();
        assert_eq!(read(&entry.id).unwrap().unwrap().pane_id, first.pane_id);
        assert_eq!(std::fs::read_to_string(cwd.join("count")).unwrap(), "run");

        save_script(root.to_str().unwrap(), "printf 'failure log\\n'; exit 7").unwrap();
        start(&manager, &entry.id, true).unwrap();
        wait(Status::Failed);
        let failed = read(&entry.id).unwrap().unwrap();
        assert_eq!(failed.exit_code, Some(7));
        assert_ne!(failed.pane_id, first.pane_id);
        assert!(log(&manager, &entry.id, &first.pane_id).is_err(), "never attach a successor's log to a stale failure");
        assert!(log(&manager, &entry.id, &failed.pane_id).unwrap().contains("failure log"));
        save_script(root.to_str().unwrap(), "printf 'waiting\\n'; read answer; printf 'finished\\n'").unwrap();
        let active = start(&manager, &entry.id, true).unwrap().unwrap();
        assert!(start(&manager, &entry.id, true).is_err(), "two windows cannot run setup concurrently");
        finished(&manager, &pty::PtyExit { id: failed.pane_id.clone(), code: Some(7) });
        assert_eq!(read(&entry.id).unwrap().unwrap().status, Status::Running, "a late exit cannot finish a successor");
        manager.terminals().write(&active.pane_id, b"continue\n").unwrap();
        wait(Status::Succeeded);
        manager.terminals().kill_all();
        assert!(log(&manager, &entry.id, &active.pane_id).unwrap().contains("finished"), "saved output survives the PTY owner");
        assert!(!list(&manager).unwrap()[0].has_pane);
        manager.closing();
    }
}
