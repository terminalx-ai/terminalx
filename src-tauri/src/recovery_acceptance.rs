//! PRIVATE, derived-build acceptance instrumentation. No control endpoint.
//! This partial overlay intentionally stops before faults until process-start
//! and fixture-launch provenance are bound; see docs/RECOVERY-ACCEPTANCE-PRIVATE.md.
use std::{fs::OpenOptions, io::Write, path::Path, sync::mpsc, time::{Duration, Instant}};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use tauri::Manager;
use crate::{sink::BroadcastSink, terminal_perf, AppState};

const ROOT: &str = "/Users/Shared/tx643-private-recovery-3d73b0a4";
const IDENTITY: &str = "com.terminalx.next.dev.recovery643.private3d73b0a4";
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);

/// Owns one native pending ID. Retirement is unconditional, including early
/// eval errors, destroyed windows, malformed answers and unwinding.
struct Observation(String);
impl Observation {
    fn new() -> Self {
        // NO listeners and NOT the app sink: the normal frontend would answer
        // unknown perf actions with an error, racing our fixed observation.
        Self(terminal_perf::ask(&BroadcastSink::new(1), "private-recovery", json!({})))
    }
    fn complete(&self, timeout: Duration) -> Option<Value> {
        terminal_perf::wait(&self.0, timeout)
    }
}
impl Drop for Observation {
    fn drop(&mut self) { let _ = terminal_perf::wait(&self.0, Duration::ZERO); }
}

// Literal source, no caller-supplied JavaScript/selector/key. Tauri2 core.js
// invoke uses __TAURI_INTERNALS__.invoke; Composer renders textarea[data-composer].
const READ_ONLY: &str = r#"(() => {
 const id = __REQUEST_ID__;
 const label = __WINDOW_LABEL__;
 const bounded = (value, max) => {
   if (value !== null && value.length > max) throw Error('snapshot field too large');
   return value;
 };
 let result;
 try {
   const fields = [...document.querySelectorAll('textarea[data-composer]')]
     .filter(e => e.getClientRects().length > 0);
   if (fields.length !== 1) throw Error('expected one visible fixture composer');
   result = {label, timeOrigin: performance.timeOrigin,
     draft: bounded(fields[0].value, 128),
     attempts: bounded(sessionStorage.getItem('terminalx.localRuntime.attempts.v1'), 8),
     checkpoint: bounded(sessionStorage.getItem('terminalx.localRuntime.localDrafts.v2'), 4096),
     notice: bounded(document.querySelector('[aria-label="Local runtime connection"]')?.textContent ?? null, 1024)};
 } catch (error) { result = {error: String(error).slice(0, 256)}; }
 void window.__TAURI_INTERNALS__.invoke('terminal_perf_reply', {id, result});
})()"#;

/// Called only on our worker. Dispatch to the event loop, then wait OFF it.
/// A delayed eval after timeout can only reply to an already retired id.
fn observe(app: &tauri::AppHandle, label: &'static str) -> Result<Value> {
    ensure!(matches!(label, "main" | "floating"), "invalid fixture window");
    let request = Observation::new();
    let deadline = Instant::now() + SNAPSHOT_TIMEOUT;
    let script = READ_ONLY.replace("__REQUEST_ID__", &serde_json::to_string(&request.0)?)
        .replace("__WINDOW_LABEL__", &serde_json::to_string(label)?);
    let (tx, rx) = mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let dispatched = handle.get_webview_window(label)
            .context("fixture window destroyed or absent")
            .and_then(|window| window.eval(&script).map_err(Into::into));
        // Never wait on a receiver in the GUI loop.
        let _ = tx.try_send(dispatched);
    })?;
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .context("snapshot dispatch deadline")??;
    let value = request.complete(deadline.saturating_duration_since(Instant::now()))
        .context("snapshot reply deadline; request retired")?;
    validate_snapshot(&value, label)?;
    Ok(value)
}

fn validate_snapshot(value: &Value, label: &str) -> Result<()> {
    ensure!(serde_json::to_vec(value)?.len() <= 8192, "snapshot exceeds bound");
    ensure!(value.get("error").is_none(), "webview observation failed: {value}");
    ensure!(value["label"] == label, "wrong snapshot label");
    ensure!(value["timeOrigin"].as_f64().is_some_and(|n| n.is_finite() && n > 0.0), "invalid document identity");
    ensure!(value["draft"].as_str().is_some_and(|s| s.len() <= 128), "invalid draft");
    for (key, limit) in [("attempts", 8), ("checkpoint", 4096), ("notice", 1024)] {
        ensure!(value.get(key).is_some_and(|v| v.is_null() || v.as_str().is_some_and(|s| s.len() <= limit)), "invalid {key}");
    }
    Ok(())
}

fn identity(app: &tauri::AppHandle) -> Result<()> {
    ensure!(app.config().identifier == IDENTITY, "wrong private app identity");
    ensure!(std::env::var("TERMINALX_RECOVERY_ACCEPTANCE").as_deref() == Ok("fixed-local-v1"), "fixture not explicitly selected");
    let root = Path::new(ROOT);
    ensure!(root.canonicalize()? == root, "root is not canonical");
    ensure!(crate::store::root()?.canonicalize()? == root.join("state"), "wrong private store");
    ensure!(std::env::var_os("HOME").map(std::path::PathBuf::from) == Some(root.join("home")), "wrong fixture HOME");
    Ok(())
}

/// Collect only the two local fixture sessions, using the SAME current Desktop
/// for owner, pane output and canonical user-message counts. No sends/starts.
fn native_evidence(app: &tauri::AppHandle) -> Result<Value> {
    let entries = crate::store::index::load()?;
    ensure!(entries.len() == 2, "exactly two fixture sessions required");
    ensure!(entries.iter().all(|s| s.project_path == format!("{ROOT}/fixture") && s.cwd == format!("{ROOT}/fixture") && s.tabs.len() == 1), "non-fixture session");
    let runtime = app.state::<AppState>().runtime().context("missing fixture owner")?;
    let sessions = runtime.sessions()?;
    let owner = runtime.acceptance_owner()?;
    ensure!(owner["pid"].as_u64().is_some_and(|n| n > 0) && owner["epoch"].as_str().is_some_and(|s| !s.is_empty()) && owner["nativeTray"] == true, "invalid owner identity");
    let mut panes = Vec::new();
    for session in entries {
        let tab = &session.tabs[0];
        ensure!(tab.harness == "claude", "fixture harness mismatch");
        let pane = sessions.pane_of(&session.id, &tab.id)?.context("fixture pane missing")?;
        let output = runtime.acceptance_output(&pane.pane_id)?;
        ensure!(output["running"] == true && output["pid"].as_u64().is_some_and(|n| n > 0), "fixture process is not live");
        ensure!(output["data"].as_str().is_some_and(|s| s.len() <= 65536), "fixture output absent or exceeds bound");
        let events = sessions.load_events(&session.id, &tab.id)?;
        let rows = serde_json::to_value(events)?;
        let rows = rows.as_array().context("event array")?;
        ensure!(rows.len() <= 2048, "fixture event bound");
        let sends = rows.iter().filter(|e| e["payload"]["type"] == "user_message").count();
        panes.push(json!({"session":session.id,"tab":tab.id,"pane":pane.pane_id,
            "output":output,"canonicalUserMessages":sends}));
    }
    Ok(json!({"owner":owner,"panes":panes}))
}

// Unconstructible outside this module. No receipt from disk/UI can grant fault
// permission. Process-start + fake executable/start provenance remain a source
// prerequisite, so this overlay currently cannot obtain the permit.
struct VerifiedFixture;
fn verify_fixture_provenance(_evidence: &Value) -> Result<VerifiedFixture> {
    bail!("GAP: pinned owner status/PTY output and canonical user-message counts do not bind process start identity, fake executable or launch count; faults remain disarmed")
}

fn fault(app: &tauri::AppHandle, _permit: &VerifiedFixture, shared: bool) -> Result<()> {
    identity(app)?;
    // Resolve again for EACH fault, especially after shared reconnect; never
    // inject through a retained old Desktop/Bridge. No locks cross an await.
    app.state::<AppState>().runtime().context("current owner absent")?.acceptance_eof(shared)
}

fn scenario(app: &tauri::AppHandle, log: &mut std::fs::File) -> Result<()> {
    let main = observe(app, "main")?;
    let floating = observe(app, "floating")?;
    ensure!(main["draft"] == "tx643-main-unsent" && floating["draft"] == "tx643-floating-unsent", "fixture sentinels absent");
    let native = native_evidence(app)?;
    serde_json::to_writer(&mut *log, &json!({"phase":"baseline-only","main":main,"floating":floating,"native":native}))?;
    writeln!(log)?;
    let permit = verify_fixture_provenance(&native)?;
    fault(app, &permit, false)?;
    // Do not add another fault before the still-missing fresh-output/PID/start
    // and reload acceptance oracle. Fail closed, never report a passing phase.
    bail!("GAP: post-fault continuity oracle not yet implemented")
}

pub(crate) fn install(app: &tauri::AppHandle) {
    if let Err(error) = identity(app) {
        log::warn!("private recovery acceptance disabled: {error:#}");
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("private-recovery-acceptance".into()).spawn(move || {
        use std::os::unix::fs::OpenOptionsExt;
        let path = Path::new(ROOT).join("recovery-observations.jsonl");
        let Ok(mut log) = OpenOptions::new().write(true).create_new(true).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path) else { return; };
        let result = scenario(&app, &mut log);
        let _ = serde_json::to_writer(&mut log, &json!({"result":"INCOMPLETE", "error":result.err().map(|e|format!("{e:#}"))}));
        let _ = writeln!(log);
        let _ = log.sync_all();
    });
    if let Err(error) = spawned { log::error!("private recovery worker not started: {error}"); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_valid_reply_completes_off_dispatch_thread() {
        let request = Observation::new();
        let id = request.0.clone();
        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            terminal_perf::reply(&id, json!({"delayed":true}));
        });
        assert_eq!(request.complete(Duration::from_secs(1)), Some(json!({"delayed":true})));
        sender.join().unwrap();
        assert_eq!(terminal_perf::poll(&request.0), Err(()));
    }
    #[test]
    fn timeout_and_late_reply_cannot_retain_an_id() {
        let request = Observation::new();
        assert_eq!(request.complete(Duration::from_millis(1)), None);
        terminal_perf::reply(&request.0, json!("late"));
        assert_eq!(terminal_perf::poll(&request.0), Err(()));
    }
    #[test]
    fn dispatch_failure_or_destroyed_window_retires_request() {
        let request = Observation::new();
        let id = request.0.clone();
        drop(request);
        terminal_perf::reply(&id, json!("late dispatch"));
        assert_eq!(terminal_perf::poll(&id), Err(()));
    }
    #[test]
    fn invalid_reply_is_retired_before_validation() {
        let request = Observation::new();
        terminal_perf::reply(&request.0, json!({"error":"fixture"}));
        let reply = request.complete(Duration::from_secs(1)).unwrap();
        assert!(validate_snapshot(&reply, "main").is_err());
        assert_eq!(terminal_perf::poll(&request.0), Err(()));
    }
    #[test]
    fn no_supplied_receipt_can_arm_an_unbound_fixture() {
        assert!(verify_fixture_provenance(&json!({"verified":true})).is_err());
    }
}
