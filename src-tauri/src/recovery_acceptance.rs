//! PRIVATE, derived-build acceptance instrumentation. No control endpoint.
//! Never enabled in the owner/ordinary build. Interpreter pins and a durable
//! explicit handoff are prerequisites, not receipt-based authority.
use std::{fs::OpenOptions, io::Write, path::Path, sync::mpsc, time::{Duration, Instant}};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use tauri::Manager;
use crate::{sink::BroadcastSink, terminal_perf, AppState};
#[path = "recovery_fixture.rs"]
mod fixture;

const ROOT: &str = "/Users/Shared/tx643-private-recovery-3d73b0a4";
const IDENTITY: &str = "com.terminalx.next.dev.recovery643.private3d73b0a4";
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);
const PHASE_TIMEOUT: Duration = Duration::from_secs(45);
static RECONNECTS: std::sync::Mutex<[u64; 2]> = std::sync::Mutex::new([0, 0]);
static ACTIVE_RECONNECTS: std::sync::Mutex<[u64; 2]> = std::sync::Mutex::new([0, 0]);
pub(crate) struct ReconnectCall(usize);
impl Drop for ReconnectCall {
    fn drop(&mut self) { ACTIVE_RECONNECTS.lock().unwrap()[self.0] -= 1; }
}
pub(crate) fn record_reconnect(label: &str) -> Option<ReconnectCall> {
    let index = match label { "main" => 0, "floating" => 1, _ => return None };
    RECONNECTS.lock().unwrap()[index] += 1;
    ACTIVE_RECONNECTS.lock().unwrap()[index] += 1;
    Some(ReconnectCall(index))
}
fn counts() -> [u64; 2] { *RECONNECTS.lock().unwrap() }
static VIEW_BYTES: std::sync::Mutex<[Vec<u8>; 2]> = std::sync::Mutex::new([Vec::new(), Vec::new()]);
pub(crate) fn record_view_bytes(window: &str, bytes: &[u8]) {
    let index = match window { "main" => 0, "floating" => 1, _ => return };
    let mut all = VIEW_BYTES.lock().unwrap();
    let tail = &mut all[index];
    tail.extend_from_slice(&bytes[bytes.len().saturating_sub(8192)..]);
    let excess = tail.len().saturating_sub(16384);
    if excess > 0 { tail.drain(..excess); }
}
fn view_cursors(bound: &fixture::Bound) -> Result<[(String,u64);2]> {
    let all = VIEW_BYTES.lock().unwrap();
    Ok([bound.visible_cursor(&all[0])?, bound.visible_cursor(&all[1])?])
}

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
    fixture::private_dir(root)?;
    fixture::private_dir(&root.join("home"))?;
    fixture::private_dir(&root.join("state"))?;
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
        panes.push(json!({"session":session.id,"tab":tab.id,"pane":pane.pane_id,"providerSession":tab.provider_session_id,
            "output":output,"canonicalUserMessages":sends}));
    }
    Ok(json!({"owner":owner,"panes":panes}))
}

struct VerifiedFixture(fixture::Bound);
fn verify_fixture_provenance(evidence: &Value) -> Result<VerifiedFixture> {
    Ok(VerifiedFixture(fixture::bind(evidence)?))
}

fn fault(app: &tauri::AppHandle, permit: &VerifiedFixture, shared: bool) -> Result<()> {
    identity(app)?;
    let current = fixture::bind(&native_evidence(app)?)?;
    ensure!(permit.0.same_lifetimes(&current), "fixture changed before fault");
    // Resolve again for EACH fault, especially after shared reconnect; never
    // inject through a retained old Desktop/Bridge. No locks cross an await.
    app.state::<AppState>().runtime().context("current owner absent")?.acceptance_eof(shared)
}

fn persist(log: &mut std::fs::File, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *log, value)?;
    writeln!(log)?;
    log.sync_all()?;
    Ok(())
}

fn wait_handoff(name: &str, nonce: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(180);
    while !fixture::handoff(name, nonce)? {
        ensure!(Instant::now() < deadline, "missing explicit {name} handoff");
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(())
}

fn check_budget(snapshot: &Value, calls: u64) -> Result<()> {
    let value = snapshot["attempts"].as_str().unwrap_or("0").parse::<u64>()?;
    ensure!(value == calls.min(3), "window lifetime attempt budget mismatch");
    Ok(())
}

/// Read-only pagehide witness. Registration is acknowledged before the fault.
/// Failure to deliver IPC before document destruction is INCOMPLETE, never a
/// reason to infer that a checkpoint existed. Both ids retire on every path.
fn checkpoint_witness(app: &tauri::AppHandle, label: &'static str) -> Result<Observation> {
    let witness = Observation::new();
    let ack = Observation::new();
    let script = r#"(() => {
      const report = () => {
        let result;
        try {
          const checkpoint = sessionStorage.getItem('terminalx.localRuntime.localDrafts.v2');
          if (checkpoint === null || checkpoint.length > 4096) throw Error('checkpoint missing/oversize');
          result = {checkpoint, timeOrigin:performance.timeOrigin, label:__LABEL__};
        } catch (e) { result = {error:String(e).slice(0,256)}; }
        void window.__TAURI_INTERNALS__.invoke('terminal_perf_reply', {id:__WITNESS__, result});
      };
      window.addEventListener('pagehide', report, {once:true});
      void window.__TAURI_INTERNALS__.invoke('terminal_perf_reply', {id:__ACK__, result:'installed'});
    })()"#.replace("__LABEL__", &serde_json::to_string(label)?)
        .replace("__WITNESS__", &serde_json::to_string(&witness.0)?)
        .replace("__ACK__", &serde_json::to_string(&ack.0)?);
    let handle = app.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    let deadline = Instant::now() + SNAPSHOT_TIMEOUT;
    app.run_on_main_thread(move || {
        let result = handle.get_webview_window(label).context("checkpoint window absent")
            .and_then(|w| w.eval(&script).map_err(Into::into));
        let _ = tx.try_send(result);
    })?;
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))??;
    ensure!(ack.complete(deadline.saturating_duration_since(Instant::now())) == Some(json!("installed")), "checkpoint witness not installed");
    Ok(witness)
}

fn check_checkpoint(value: &Value, before: &Value, sentinel: &str, native: &Value, pane: &str) -> Result<()> {
    ensure!(value["timeOrigin"] == before["timeOrigin"] && value["label"] == before["label"], "wrong checkpoint document/window");
    let text = value["checkpoint"].as_str().context("no actual pre-reload checkpoint witness")?;
    ensure!(text.len() <= 4096, "checkpoint bound");
    let pairs: Vec<(String, String)> = serde_json::from_str(text)?;
    let allowed: Vec<&str> = native["panes"].as_array().context("native panes")?.iter()
        .filter_map(|p| p["tab"].as_str()).collect();
    let tab = native["panes"].as_array().context("native panes")?.iter()
        .find(|p| p["pane"] == pane).and_then(|p| p["tab"].as_str()).context("checkpoint pane/tab binding")?;
    ensure!(pairs.iter().all(|(id,_)| allowed.contains(&id.as_str())), "nonlocal checkpoint entry");
    ensure!(pairs.iter().filter(|(id,text)| id == tab && text == sentinel).count() == 1, "checkpoint does not contain exact visible tab draft");
    ensure!(pairs.iter().map(|(id,_)|id).collect::<std::collections::BTreeSet<_>>().len() == pairs.len(), "duplicate checkpoint tab");
    ensure!(!sentinel.is_empty() || pairs.iter().all(|(_,text)|text != "tx643-main-unsent"), "cleared sentinel resurrected");
    Ok(())
}

fn recovered_phase(app: &tauri::AppHandle, log: &mut std::fs::File, permit: &VerifiedFixture,
    shared: bool, cleared: bool, manual: bool) -> Result<()> {
    let before = [observe(app, "main")?, observe(app, "floating")?];
    let native_before = native_evidence(app)?;
    let bound_before = fixture::bind(&native_before)?;
    let visible_before = view_cursors(&bound_before)?;
    ensure!(visible_before[0].0 != visible_before[1].0, "main/floating must display different fixture panes");
    ensure!(permit.0.same_lifetimes(&bound_before), "fixture before phase changed");
    let calls = counts();
    ensure!(*ACTIVE_RECONNECTS.lock().unwrap() == [0,0], "prior reconnect still in flight");
    let witnesses = [Some(checkpoint_witness(app,"main")?), if shared { Some(checkpoint_witness(app,"floating")?) } else { None }];
    fault(app, permit, shared)?;
    if manual {
        // Already exhausted: demonstrate no automatic reconnect through two
        // health-poll periods before waiting for a real candidate UI action.
        let quiet_until = Instant::now() + Duration::from_secs(12);
        while Instant::now() < quiet_until {
            ensure!(counts() == calls, "automatic retry exceeded lifetime budget");
            std::thread::sleep(Duration::from_millis(250));
        }
        persist(log, &json!({"phase":"manual-reconnect-required","calls":calls}))?;
    }
    let deadline = Instant::now() + if manual { Duration::from_secs(180) } else { PHASE_TIMEOUT };
    let after = loop {
        ensure!(Instant::now() < deadline, "recovery phase deadline");
        let (Ok(main), Ok(floating)) = (observe(app,"main"), observe(app,"floating")) else {
            // The real document may be between unload and composer mount.
            // Each failed observation has already retired its own pending id.
            std::thread::sleep(Duration::from_millis(250));
            continue;
        };
        let main_changed = main["timeOrigin"] != before[0]["timeOrigin"];
        let floating_ok = if shared { floating["timeOrigin"] != before[1]["timeOrigin"] } else { floating["timeOrigin"] == before[1]["timeOrigin"] };
        if main_changed && floating_ok && main["notice"].is_null() && floating["notice"].is_null() { break [main,floating]; }
        std::thread::sleep(Duration::from_millis(250));
    };
    while *ACTIVE_RECONNECTS.lock().unwrap() != [0,0] {
        ensure!(Instant::now() < deadline, "reconnect completion deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    let now_calls = counts();
    ensure!(now_calls[0] == calls[0] + 1 || (shared && now_calls[0] == calls[0]), "unexpected main reconnect count");
    ensure!(now_calls[1] == calls[1] || (shared && now_calls[1] == calls[1] + 1), "unexpected floating reconnect count");
    ensure!(!shared || now_calls.iter().sum::<u64>() > calls.iter().sum::<u64>(), "shared failure had no reconnect");
    for (index, sentinel) in [if cleared { "" } else { "tx643-main-unsent" }, "tx643-floating-unsent"].iter().enumerate() {
        ensure!(after[index]["draft"] == *sentinel && after[index]["checkpoint"].is_null(), "draft lost/resurrected or checkpoint unconsumed");
        check_budget(&after[index], now_calls[index])?;
        if let Some(witness) = &witnesses[index] {
            let value = witness.complete(deadline.saturating_duration_since(Instant::now())).context("pagehide evidence missing")?;
            check_checkpoint(&value, &before[index], sentinel, &native_before, &visible_before[index].0)?;
            persist(log, &json!({"phase":"checkpoint-witness","value":value}))?;
        }
    }
    // Output can be emitted just after the reload; wait only within this phase
    // deadline for bytes strictly beyond BOTH previously captured PTY cursors.
    let fresh = loop {
        let bound = fixture::bind(&native_evidence(app)?)?;
        ensure!(permit.0.same_lifetimes(&bound), "process/start/send identity changed");
        let visible = view_cursors(&bound)?;
        if bound_before.fresh_output(&bound) && visible.iter().zip(&visible_before)
            .all(|((id,n),(old_id,old_n))| id == old_id && n > old_n) { break bound; }
        ensure!(Instant::now() < deadline, "no fresh PTY output");
        std::thread::sleep(Duration::from_millis(250));
    };
    ensure!(counts() == now_calls && *ACTIVE_RECONNECTS.lock().unwrap() == [0,0], "late extra reconnect");
    persist(log, &json!({"phase":"recovered","shared":shared,"cleared":cleared,"manual":manual,
        "before":before,"after":after,"calls":now_calls,"native":fresh,
        "viewBefore":visible_before,"viewAfter":view_cursors(&fresh)?}))
}

fn scenario(app: &tauri::AppHandle, log: &mut std::fs::File) -> Result<()> {
    let nonce = fixture::challenge()?;
    persist(log, &json!({"phase":"waiting-fixture-ready","challenge":nonce}))?;
    wait_handoff("fixture-ready", &nonce)?;
    let main = observe(app, "main")?;
    let floating = observe(app, "floating")?;
    ensure!(main["draft"] == "tx643-main-unsent" && floating["draft"] == "tx643-floating-unsent", "fixture sentinels absent");
    let native = native_evidence(app)?;
    ensure!(counts() == [0,0], "fixture already attempted recovery");
    check_budget(&main,0)?; check_budget(&floating,0)?;
    persist(log, &json!({"phase":"baseline","main":main,"floating":floating,"native":native}))?;
    let permit = verify_fixture_provenance(&native)?;
    recovered_phase(app,log,&permit,false,false,false)?;
    recovered_phase(app,log,&permit,true,false,false)?;
    for _ in 0..2 {
        if counts()[0] == 3 { break; }
        ensure!(counts()[0] < 3, "unexpected retry count");
        recovered_phase(app,log,&permit,false,false,false)?;
    }
    ensure!(counts()[0] == 3, "automatic retry budget not exhausted");
    recovered_phase(app,log,&permit,false,false,true)?;
    persist(log, &json!({"phase":"clear-main-draft-required","challenge":nonce}))?;
    wait_handoff("clear-ready", &nonce)?;
    ensure!(observe(app,"main")?["draft"] == "", "clear handoff did not actually clear draft");
    recovered_phase(app,log,&permit,false,true,true)?;
    Ok(())
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
        let result = (|| -> Result<()> {
            let mut challenge = OpenOptions::new().write(true).create_new(true).mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(Path::new(ROOT).join("challenge"))?;
            write!(challenge, "{}", uuid::Uuid::new_v4())?;
            challenge.sync_all()?;
            scenario(&app, &mut log)
        })();
        let terminal = match result { Ok(()) => json!({"result":"LOCAL_SCENARIO_COMPLETE"}),
            Err(error) => json!({"result":"INCOMPLETE","error":format!("{error:#}")}) };
        if let Err(error) = persist(&mut log, &terminal) {
            log::error!("private fixture evidence incomplete: {error:#}");
        }
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
        // Rejected before filesystem or native process observation.
        assert!(verify_fixture_provenance(&json!({"verified":true})).is_err());
    }
    #[test]
    fn saturated_storage_does_not_replace_native_manual_call_count() {
        assert!(check_budget(&json!({"attempts":"3"}), 2).is_err());
        assert!(check_budget(&json!({"attempts":"3"}), 3).is_ok());
        assert!(check_budget(&json!({"attempts":"3"}), 4).is_ok());
    }
    #[test]
    fn checkpoint_requires_exact_document_and_local_tab_text() {
        let native = json!({"panes":[{"tab":"t","pane":"p"}]});
        let before = json!({"timeOrigin":1,"label":"main"});
        let valid = json!({"timeOrigin":1,"label":"main","checkpoint":"[[\"t\",\"draft\"]]"});
        assert!(check_checkpoint(&valid,&before,"draft",&native,"p").is_ok());
        assert!(check_checkpoint(&valid,&before,"",&native,"p").is_err());
        assert!(check_checkpoint(&valid,&json!({"timeOrigin":2,"label":"main"}),"draft",&native,"p").is_err());
        assert!(check_checkpoint(&valid,&before,"draft",&json!({"panes":[{"tab":"foreign","pane":"p"}]}),"p").is_err());
    }
}
