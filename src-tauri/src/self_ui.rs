//! Explicit, expiring access to semantic session controls in the main window.
//! No raw AX tree, screenshots, coordinates, keys, settings or confirmations
//! cross this boundary. Native computer providers keep their own-app guard.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use crate::{control::ControlError, issue_control::{Ask, Question}, sink::EventSink};

pub const ACTIONS: &[&str] = &["open-autopilot", "toggle-merge", "toggle-conflicts", "start-autopilot", "adopt-pr"];
const RECOVERY: &str = "Use terminalx computer self-ui authorize --session SESSION --tab TAB --window main --actions ACTIONS. The person approves the bounded grant in TerminalX. For Autopilot without UI use terminalx pipelines start SESSION-OR-TAB [--adopt-pr].";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    id: String,
    session_id: String,
    tab_id: String,
    window: String,
    actions: BTreeSet<String>,
    expires_at: u64,
    actor: crate::issue_pipeline::SwitchActor,
    #[serde(skip)]
    deadline: Instant,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    id: String,
    session_id: String,
    tab_id: String,
    action: String,
    actions: BTreeSet<String>,
    expires_at: u64,
    #[serde(skip)]
    actor: crate::issue_pipeline::SwitchActor,
}
struct Pending {
    grant: String,
    request: Request,
    deadline: Instant,
    claimed: bool,
    started: bool,
    reply: mpsc::Sender<Result<Value, ControlError>>,
}
#[derive(Default)]
struct Access {
    grants: BTreeMap<String, Grant>,
    pending: BTreeMap<String, Pending>,
}
fn access() -> &'static Mutex<Access> {
    static ACCESS: OnceLock<Mutex<Access>> = OnceLock::new();
    ACCESS.get_or_init(Mutex::default)
}
fn denied(message: &str) -> ControlError { ControlError::new("own_app_protected", message, Some(RECOVERY.to_string())) }
fn field<'a>(params: &'a Value, name: &str) -> Result<&'a str, ControlError> {
    params[name].as_str().filter(|value| !value.is_empty()).ok_or_else(|| ControlError::invalid(format!("{name} is required.")))
}
fn check<'a>(state: &'a Access, id: &str, window: &str, action: &str, now: Instant) -> Result<&'a Grant, ControlError> {
    let grant = state.grants.get(id).filter(|grant| now < grant.deadline).ok_or_else(|| denied("Self-UI authorization is absent, revoked or expired."))?;
    if grant.window != window { return Err(denied("The authorization does not cover this window.")); }
    if action != "snapshot" && !grant.actions.contains(action) { return Err(denied("The authorization does not cover this control.")); }
    if crate::cloud_control::confirming() { return Err(ControlError::new("confirmation_pending", "A person-only confirmation is pending. Self-UI is suspended.", None::<String>)); }
    Ok(grant)
}
fn request_check(state: &Access, id: &str, window: &str) -> Result<Request, ControlError> {
    let pending = state.pending.get(id).filter(|p| Instant::now() < p.deadline).ok_or_else(|| denied("This UI request has expired."))?;
    check(state, &pending.grant, window, &pending.request.action, Instant::now())?;
    Ok(pending.request.clone())
}

pub fn call(sink: &dyn EventSink, ask: Option<&Ask>, method: &str, params: Value) -> Result<Value, ControlError> {
    if method == "authorize" {
        let session_id = field(&params, "session")?;
        let tab_id = field(&params, "tab")?;
        let window = field(&params, "window")?;
        if window != "main" { return Err(denied("Self-UI is supported only in the main window.")); }
        let session = crate::store::index::load().map_err(ControlError::internal)?.into_iter().find(|session| session.id == session_id && session.tab(tab_id).is_some()).ok_or_else(|| denied("Name the exact existing session and author tab ids."))?;
        let actions: BTreeSet<String> = field(&params, "actions")?.split(',').map(str::to_string).collect();
        if actions.iter().any(|action| !ACTIONS.contains(&action.as_str())) { return Err(ControlError::invalid("Unsupported self-UI action. Only open-autopilot, toggle-merge, toggle-conflicts, start-autopilot and adopt-pr are available.")); }
        let seconds = params["seconds"].as_u64().unwrap_or(300);
        if !(1..=900).contains(&seconds) { return Err(ControlError::invalid("Self-UI authorization lasts 1 to 900 seconds.")); }
        let ask = ask.ok_or_else(|| denied("Authorization needs the desktop confirmation UI."))?;
        let answer = ask(Question {
            session_id: Some(session_id.into()), session_title: Some(session.title), project: session.project_path,
            target: format!("main window / session {session_id} / tab {tab_id}"), summary: "Allow scoped agent UI access".into(), description: None,
            title: "Allow agent access to session controls?".into(),
            message: format!("For {seconds} seconds, allow inspection and these controls only: {}. Actions are attributed to an agent. No screenshots, other sessions, credentials, settings, confirmations, review extensions or security overrides are exposed. Revoke with terminalx computer self-ui revoke GRANT or the access banner.", actions.iter().cloned().collect::<Vec<_>>().join(", ")),
            agree: "Allow session controls".into(),
        });
        if answer != crate::cloud_control::Answer::Accepted { return Err(denied("Self-UI authorization was not approved by the person.")); }
        // Caller ids are attribution claims, never authority. The person
        // approves the target session/window/actions regardless of this metadata.
        let actor = crate::issue_pipeline::SwitchActor::SelfUi {
            session_id: params["caller"]["session"].as_str().map(str::to_owned),
            tab_id: params["caller"]["tab"].as_str().map(str::to_owned),
        };
        let duration = Duration::from_secs(seconds);
        let grant = Grant { id: uuid::Uuid::new_v4().to_string(), session_id: session_id.into(), tab_id: tab_id.into(), window: window.into(), actions, actor, deadline: Instant::now() + duration,
            expires_at: (std::time::SystemTime::now() + duration).duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 };
        let mut state = access().lock().unwrap();
        state.grants.retain(|_, grant| Instant::now() < grant.deadline);
        if state.grants.len() >= 16 { return Err(denied("Revoke an existing self-UI grant before authorizing another.")); }
        state.grants.insert(grant.id.clone(), grant.clone());
        drop(state);
        sink.emit("self-ui-grants-changed", &json!({}));
        return Ok(json!({"grant": grant, "actor": "agent"}));
    }
    let grant_id = field(&params, "grant")?;
    if method == "revoke" {
        let removed = revoke(grant_id);
        sink.emit("self-ui-grants-changed", &json!({}));
        return Ok(json!({"revoked": removed}));
    }
    if !matches!(method, "snapshot" | "click") { return Err(ControlError::invalid("Unknown self-UI operation.")); }
    let action = if method == "snapshot" { "snapshot" } else { field(&params, "control")? };
    let window = field(&params, "window")?;
    let (sender, receiver) = mpsc::channel();
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut state = access().lock().unwrap();
        let grant = check(&state, grant_id, window, action, Instant::now())?.clone();
        if state.pending.values().any(|p| p.grant == grant_id) { return Err(denied("Another self-UI request is in progress for this grant.")); }
        let request = Request { id: id.clone(), session_id: grant.session_id, tab_id: grant.tab_id, action: action.into(), actions: grant.actions, expires_at: grant.expires_at, actor: grant.actor };
        state.pending.insert(id.clone(), Pending { grant: grant_id.into(), request, deadline: grant.deadline.min(Instant::now() + Duration::from_secs(25)), claimed: false, started: false, reply: sender });
    }
    sink.emit("self-ui-request", &json!({"id": id}));
    let result = receiver.recv_timeout(Duration::from_secs(25)).unwrap_or_else(|_| Err(ControlError::new("action_timeout", "The session UI did not confirm the result. Inspect before retrying.", None::<String>)));
    access().lock().unwrap().pending.remove(&id);
    result
}
fn revoke(id: &str) -> bool {
    let mut state = access().lock().unwrap();
    let removed = state.grants.remove(id).is_some();
    state.pending.retain(|_, pending| {
        if pending.grant != id { return true; }
        let _ = pending.reply.send(Err(denied("Self-UI authorization was revoked.")));
        false
    });
    removed
}

#[tauri::command]
pub fn self_ui_claim(window: tauri::WebviewWindow, id: String) -> Result<Request, ControlError> {
    claim(window.label(), &id)
}
fn claim(window: &str, id: &str) -> Result<Request, ControlError> {
    let mut state = access().lock().unwrap();
    let request = request_check(&state, id, window)?;
    let pending = state.pending.get_mut(id).unwrap();
    if pending.claimed { return Err(denied("This UI request was already claimed.")); }
    pending.claimed = true;
    Ok(request)
}

#[tauri::command]
pub fn self_ui_validate(window: tauri::WebviewWindow, id: String) -> Result<(), ControlError> {
    request_check(&access().lock().unwrap(), &id, window.label()).map(|_| ())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    id: String,
    enabled: bool,
    checked: Option<bool>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    session_id: String,
    tab_id: String,
    controls: Vec<Control>,
    pipeline_id: Option<String>,
    pipeline_state: Option<crate::issue_pipeline::State>,
}
#[tauri::command]
pub fn self_ui_reply(window: tauri::WebviewWindow, id: String, snapshot: Option<Snapshot>, error: Option<String>) -> Result<(), ControlError> {
    reply(window.label(), &id, snapshot, error)
}
fn reply(window: &str, id: &str, snapshot: Option<Snapshot>, error: Option<String>) -> Result<(), ControlError> {
    let mut state = access().lock().unwrap();
    let request = request_check(&state, id, window)?;
    if !state.pending[id].claimed { return Err(denied("The UI request was not claimed.")); }
    let result = if let Some(snapshot) = snapshot {
        if snapshot.session_id != request.session_id || snapshot.tab_id != request.tab_id || snapshot.controls.iter().any(|control| !ACTIONS.contains(&control.id.as_str())) {
            return Err(denied("The UI result is outside the authorized session or controls."));
        }
        Ok(json!({"snapshot": snapshot, "actor": "agent", "action": request.action, "verified": true, "screenshotStatus": {"state":"skipped", "reason":"scoped_semantic_ui"}}))
    } else {
        // Do not pass arbitrary DOM or exception text back through the boundary.
        Err(ControlError::new("window_stale", if error.is_some() { "The authorized session controls are unavailable or the action failed. Inspect the session before retrying." } else { "The UI returned no state." }, None::<String>))
    };
    if let Some(pending) = state.pending.remove(id) { let _ = pending.reply.send(result); }
    Ok(())
}

/// Revalidate in native code immediately before the mutation. A stale event,
/// a different window or a revoked grant cannot activate a pipeline.
#[tauri::command]
pub async fn self_ui_start(window: tauri::WebviewWindow, id: String, auto_merge: bool, resolve_conflicts: bool) -> Result<Value, ControlError> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let request = {
            let mut state = access().lock().unwrap();
            let request = request_check(&state, &id, &label)?;
            let pending = state.pending.get_mut(&id).unwrap();
            if !pending.claimed || pending.started || !matches!(request.action.as_str(), "start-autopilot" | "adopt-pr") { return Err(denied("This request cannot activate Autopilot.")); }
            pending.started = true;
            request
        };
        let sessions = app.state::<crate::AppState>().sessions().map_err(ControlError::internal)?;
        let caller = match request.actor {
            crate::issue_pipeline::SwitchActor::SelfUi { session_id, tab_id } => json!({"session":session_id,"tab":tab_id}),
            _ => return Err(denied("Self-UI activation must carry agent attribution.")),
        };
        sessions.pipeline("startAgent", json!({"sessionId":request.session_id,"tabId":request.tab_id,"autoMerge":auto_merge,"resolveConflicts":resolve_conflicts,"adoptPr":request.action == "adopt-pr", "caller":caller})).map_err(ControlError::internal)
    }).await.map_err(ControlError::internal)?
}
#[tauri::command]
pub fn self_ui_grants(window: tauri::WebviewWindow) -> Value {
    if window.label() != "main" { return json!([]); }
    json!(access().lock().unwrap().grants.values().filter(|grant| Instant::now() < grant.deadline).collect::<Vec<_>>())
}
#[tauri::command]
pub fn self_ui_revoke(window: tauri::WebviewWindow, id: String) {
    if window.label() == "main" {
        revoke(&id);
        use tauri::Emitter;
        let _ = window.app_handle().emit("self-ui-grants-changed", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::cloud_control::Answer;
    fn grant() -> Grant {
        Grant { id: uuid::Uuid::new_v4().to_string(), session_id: "author".into(), tab_id: "t1".into(), window: "main".into(), actions: BTreeSet::from(["toggle-merge".into()]), expires_at: 123, actor: crate::issue_pipeline::SwitchActor::SelfUi { session_id: None, tab_id: None }, deadline: Instant::now() + Duration::from_secs(60) }
    }
    #[test]
    fn scopes_are_explicit_expiring_and_never_cover_security_controls() {
        let _home = crate::store::temp_home();
        let g = grant();
        let mut state = Access::default();
        state.grants.insert(g.id.clone(), g.clone());
        assert!(check(&state, &g.id, "main", "toggle-merge", Instant::now()).is_ok());
        assert!(check(&state, &g.id, "main", "snapshot", Instant::now()).is_ok());
        for (id, window, action, at) in [
            ("absent", "main", "snapshot", Instant::now()),
            (g.id.as_str(), "floating", "snapshot", Instant::now()),
            (g.id.as_str(), "main", "approve", Instant::now()),
            (g.id.as_str(), "main", "extend-review", Instant::now()),
            (g.id.as_str(), "main", "toggle-merge", g.deadline),
        ] {
            let error = check(&state, id, window, action, at).err().unwrap();
            assert_eq!(error.code, "own_app_protected");
            assert!(error.recovery.unwrap().contains("self-ui authorize"));
        }
        state.grants.remove(&g.id);
        assert!(check(&state, &g.id, "main", "toggle-merge", Instant::now()).is_err());
    }
    #[test]
    fn confirmation_and_revocation_cannot_be_automated_and_snapshots_are_scoped() {
        let _home = crate::store::temp_home();
        let session: crate::store::index::SessionEntry = serde_json::from_value(json!({"id":"author","projectPath":"/repo","cwd":"/repo","title":"Work","created":"x","modified":"x","tabs":[{"id":"t1","harness":"codex","created":"x"}]})).unwrap();
        crate::store::index::save(&[session]).unwrap();
        let sink = crate::sink::BroadcastSink::new(32);
        let params = json!({"session":"author","tab":"t1","window":"main","actions":"toggle-merge","seconds":60});
        let no: Ask = Arc::new(|_| Answer::Declined);
        assert!(call(&sink, Some(&no), "authorize", params.clone()).is_err());
        assert!(call(&sink, None, "authorize", params.clone()).is_err());
        let yes: Ask = Arc::new(|q| { assert!(q.message.contains("No screenshots")); Answer::Accepted });
        let authorized = call(&sink, Some(&yes), "authorize", params).unwrap();
        let id = authorized["grant"]["id"].as_str().unwrap().to_owned();
        {
            let _confirming = crate::cloud_control::Confirming::begin();
            assert_eq!(check(&access().lock().unwrap(), &id, "main", "toggle-merge", Instant::now()).err().unwrap().code, "confirmation_pending");
        }
        let observed = Arc::new(Mutex::new(None));
        let capture = observed.clone();
        sink.listen("self-ui-request", Box::new(move |payload| {
            let payload: Value = serde_json::from_str(payload).unwrap();
            let id = payload["id"].as_str().unwrap();
            assert!(claim("floating", id).is_err());
            let request = claim("main", id).unwrap();
            assert_eq!((request.session_id.as_str(), request.tab_id.as_str()), ("author", "t1"));
            assert!(claim("main", id).is_err());
            let wrong = Snapshot { session_id: "private-session".into(), tab_id: "t1".into(), controls: vec![], pipeline_id: None, pipeline_state: None };
            assert!(reply("main", id, Some(wrong), None).is_err());
            let state = Snapshot { session_id: "author".into(), tab_id: "t1".into(), controls: vec![Control { id: "toggle-merge".into(), enabled: true, checked: Some(true) }], pipeline_id: None, pipeline_state: None };
            *capture.lock().unwrap() = Some(id.to_owned());
            reply("main", id, Some(state), None).unwrap();
        }));
        let result = call(&sink, None, "click", json!({"grant":id,"window":"main","control":"toggle-merge"})).unwrap();
        assert_eq!(result["actor"], "agent");
        assert_eq!(result["verified"], true);
        assert_eq!(result["snapshot"]["controls"][0]["checked"], true);
        assert!(result.get("screenshot").is_none());
        assert!(!result.to_string().contains("private-session"));
        assert!(revoke(&id));
        assert!(call(&sink, None, "snapshot", json!({"grant":id,"window":"main"})).is_err());
        assert!(claim("main", observed.lock().unwrap().as_ref().unwrap()).is_err());
        assert!(serde_json::from_value::<Snapshot>(json!({"sessionId":"author","tabId":"t1","controls":[],"pipelineId":null,"treeText":"pairing code"})).is_err());
    }
    #[test]
    fn revocation_cancels_in_flight_requests_and_expired_events_cannot_be_claimed() {
        let _home = crate::store::temp_home();
        let g = grant();
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        let request = Request { id: id.clone(), session_id: g.session_id.clone(), tab_id: g.tab_id.clone(), action: "toggle-merge".into(), actions: g.actions.clone(), expires_at: g.expires_at, actor: g.actor.clone() };
        {
            let mut state = access().lock().unwrap();
            state.grants.insert(g.id.clone(), g.clone());
            state.pending.insert(id.clone(), Pending { grant: g.id.clone(), request, deadline: Instant::now() - Duration::from_secs(1), claimed: false, started: false, reply: sender });
        }
        assert!(claim("main", &id).is_err());
        access().lock().unwrap().pending.get_mut(&id).unwrap().deadline = g.deadline;
        assert!(claim("main", &id).is_ok());
        assert!(revoke(&g.id));
        assert_eq!(receiver.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err().code, "own_app_protected");
        assert!(request_check(&access().lock().unwrap(), &id, "main").is_err());
    }

}
