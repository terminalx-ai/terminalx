//! Cloud workspaces for the `terminalx` CLI (PRO-40).
//!
//! What a signed-in person may do in a cloud workspace is decided in the
//! window: the catalog, the roles and leases, the mailbox and the one place a
//! stopped workspace is woken all live there. A `cloud.*` control command is
//! therefore handed to the window as the `cloud_control_request` event and
//! answered through the `cloud_control_reply` command, so the CLI runs the
//! same code, with the same refusals, as a click in the app. Nothing here
//! holds a token or talks to the API.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::control::ControlError;
use crate::sink::EventSink;

pub const REQUEST_EVENT: &str = "cloud_control_request";

/// Lists, reads and lifecycle calls: the window answers from its stores or
/// with one API call.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(50);
/// A new session may wait for a workspace to resume (the window gives it five minutes).
const CREATE_TIMEOUT: Duration = Duration::from_secs(320);
const MAX_WAIT_SECONDS: u64 = 86_400;

/// Requests the window has not answered (`None`) or whose answer nobody has read yet.
#[derive(Default)]
struct Requests {
    answers: Mutex<HashMap<String, Option<Value>>>,
    answered: Condvar,
}

fn requests() -> &'static Requests {
    static REQUESTS: OnceLock<Requests> = OnceLock::new();
    REQUESTS.get_or_init(Requests::default)
}

/// The window's answer. One for a request nobody is waiting on is dropped.
pub fn reply(id: &str, result: Value) {
    let requests = requests();
    if let Some(answer) = requests.answers.lock().unwrap().get_mut(id) {
        *answer = Some(result);
        requests.answered.notify_all();
    }
}

fn wait(id: &str, timeout: Duration) -> Option<Value> {
    let requests = requests();
    let deadline = Instant::now() + timeout;
    let mut answers = requests.answers.lock().unwrap();
    loop {
        if matches!(answers.get(id), Some(Some(_)) | None) {
            return answers.remove(id).flatten();
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            answers.remove(id);
            return None;
        }
        answers = requests.answered.wait_timeout(answers, left).unwrap().0;
    }
}

/// How long the socket waits for the window, by what was asked.
pub(crate) fn timeout_for(action: &str, params: &Value) -> Duration {
    match action {
        "sessions.create" => CREATE_TIMEOUT,
        "wait" => {
            let seconds = params.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(600).min(MAX_WAIT_SECONDS);
            Duration::from_secs(seconds.saturating_add(20))
        }
        _ => DEFAULT_TIMEOUT,
    }
}

/// Run `cloud.<action>` in the window and return its result, or its refusal
/// with the window's own code, message and recovery.
pub fn call(sink: &dyn EventSink, action: &str, params: Value) -> Result<Value, ControlError> {
    call_within(sink, action, params.clone(), timeout_for(action, &params))
}

fn call_within(sink: &dyn EventSink, action: &str, params: Value, timeout: Duration) -> Result<Value, ControlError> {
    let id = uuid::Uuid::now_v7().to_string();
    requests().answers.lock().unwrap().insert(id.clone(), None);
    sink.emit(REQUEST_EVENT, &json!({ "id": id, "action": action, "params": params }));
    let Some(answer) = wait(&id, timeout) else {
        return Err(ControlError::new(
            "cloud_unavailable",
            "The TerminalX window did not answer in time.",
            Some("Make sure a TerminalX window is open and try again. A message already sent is not sent twice: check the session before repeating it.".to_string()),
        ));
    };
    parse_answer(answer)
}

/// `{ ok: true, result }` or `{ ok: false, error: { code, message, recovery } }`.
fn parse_answer(answer: Value) -> Result<Value, ControlError> {
    if answer.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(answer.get("result").cloned().unwrap_or(Value::Null));
    }
    let error = answer.get("error");
    let field = |name: &str| error.and_then(|error| error.get(name)).and_then(Value::as_str).map(str::to_string);
    Err(ControlError::new(
        &field("code").unwrap_or_else(|| "cloud_error".into()),
        field("message").unwrap_or_else(|| "The cloud command failed.".into()),
        field("recovery"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A window that answers every request with `answer(action, params)`.
    struct Window<F: Fn(&str, &Value) -> Option<Value> + Send + Sync>(F);

    impl<F: Fn(&str, &Value) -> Option<Value> + Send + Sync> EventSink for Window<F> {
        fn emit_raw(&self, event: &str, payload: Box<serde_json::value::RawValue>) {
            assert_eq!(event, REQUEST_EVENT);
            let payload: Value = serde_json::from_str(payload.get()).unwrap();
            let id = payload["id"].as_str().unwrap().to_string();
            if let Some(answer) = (self.0)(payload["action"].as_str().unwrap(), &payload["params"]) {
                std::thread::spawn(move || reply(&id, answer));
            }
        }
        fn listen(&self, _event: &str, _handler: crate::sink::Handler) -> crate::sink::ListenerId {
            unreachable!("the bridge never listens")
        }
        fn unlisten(&self, _id: crate::sink::ListenerId) {}
    }

    #[test]
    fn a_result_and_a_refusal_come_back_as_the_window_gave_them() {
        let window: Arc<dyn EventSink> = Arc::new(Window(|action: &str, params: &Value| {
            Some(match action {
                "projects.list" => json!({ "ok": true, "result": { "projects": [], "org": params["org"] } }),
                _ => json!({ "ok": false, "error": { "code": "forbidden", "message": "Only an organization owner or admin can stop, archive or delete a cloud workspace.", "recovery": null } }),
            })
        }));
        let listed = call(window.as_ref(), "projects.list", json!({ "org": "org-a" })).unwrap();
        assert_eq!(listed, json!({ "projects": [], "org": "org-a" }));
        let refused = call(window.as_ref(), "stop", json!({ "workspace": "cloud:org-a:ws-1" })).unwrap_err();
        assert_eq!(refused.code, "forbidden");
        assert!(refused.message.contains("owner or admin"));
        assert_eq!(refused.recovery, None);
    }

    #[test]
    fn a_window_that_does_not_answer_is_an_error_and_leaves_nothing_behind() {
        let window: Arc<dyn EventSink> = Arc::new(Window(|_: &str, _: &Value| None));
        let error = call_within(window.as_ref(), "sessions.list", json!({}), Duration::from_millis(30)).unwrap_err();
        assert_eq!(error.code, "cloud_unavailable");
        // A late answer for it is dropped.
        reply("no-such-request", json!({ "ok": true }));
    }

    #[test]
    fn an_answer_in_no_known_shape_is_a_failure_never_a_success() {
        assert_eq!(parse_answer(json!({ "result": { "sessions": [] } })).unwrap_err().code, "cloud_error");
        assert_eq!(parse_answer(json!("ok")).unwrap_err().code, "cloud_error");
        assert_eq!(parse_answer(json!({ "ok": true })).unwrap(), Value::Null);
    }

    #[test]
    fn the_socket_waits_as_long_as_the_command_may_take() {
        assert_eq!(timeout_for("read", &json!({})), DEFAULT_TIMEOUT);
        assert_eq!(timeout_for("sessions.create", &json!({})), CREATE_TIMEOUT);
        assert_eq!(timeout_for("wait", &json!({ "timeoutSeconds": 30 })), Duration::from_secs(50));
        assert_eq!(timeout_for("wait", &json!({ "timeoutSeconds": u64::MAX })), Duration::from_secs(MAX_WAIT_SECONDS + 20));
    }
}
