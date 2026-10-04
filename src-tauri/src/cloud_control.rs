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
/// One `wait` call is short (the window allows 30 s); the CLI asks again
/// until its own timeout, so a caller that goes away leaves nothing long
/// running in the window.
pub(crate) const WAIT_CHUNK_SECONDS: u64 = 30;

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
            let seconds = params.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(WAIT_CHUNK_SECONDS).min(WAIT_CHUNK_SECONDS);
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

// ---- The person's switch and their answers --------------------------------
//
// Both are kept here, in native code, and not in the window:
//
// - The switch ("Let agents in local sessions control cloud workspaces") is a
//   file under the app's home, read by the control socket itself before a
//   `cloud.*` command reaches the window. Turning it on asks the person in a
//   native dialog. A local process that can write files in the app's home can
//   still edit it: this guards against an agent using the app, not against
//   one that already has the person's files.
// - A question is a native dialog whose default button refuses. While one is
//   open, computer-use actions are refused (`confirming`), so an agent that
//   can click and type cannot answer its own request. After a refusal no new
//   question is shown for a while (`backoff`).


const SETTING_FILE: &str = "cloud-control.json";
/// After a refusal: no question for a minute, then two, four, eight, at most fifteen.
const BACKOFF_FIRST: Duration = Duration::from_secs(60);
const BACKOFF_MAX: Duration = Duration::from_secs(15 * 60);

// One counter for the process. In tests it is per thread, so a test that
// opens a question does not pause the computer-use tests running beside it.
#[cfg(not(test))]
static CONFIRMING: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
#[cfg(test)]
thread_local! {
    static CONFIRMING: std::cell::Cell<isize> = const { std::cell::Cell::new(0) };
}

#[cfg(not(test))]
fn open_questions(change: isize) -> isize {
    CONFIRMING.fetch_add(change, std::sync::atomic::Ordering::SeqCst) + change
}

#[cfg(test)]
fn open_questions(change: isize) -> isize {
    CONFIRMING.with(|count| {
        count.set(count.get() + change);
        count.get()
    })
}

/// Whether a question of this app is waiting for the person right now.
pub fn confirming() -> bool {
    open_questions(0) > 0
}

/// Held while a question is on screen.
pub struct Confirming(());

impl Confirming {
    pub fn begin() -> Self {
        open_questions(1);
        Self(())
    }
}

impl Drop for Confirming {
    fn drop(&mut self) {
        open_questions(-1);
    }
}

#[derive(Default)]
struct Refusals {
    strikes: u32,
    until: Option<Instant>,
}

fn refusals() -> &'static Mutex<Refusals> {
    static REFUSALS: OnceLock<Mutex<Refusals>> = OnceLock::new();
    REFUSALS.get_or_init(Mutex::default)
}

/// What became of a question.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    Accepted,
    Declined,
    /// Not asked: the person refused a moment ago. Seconds until a question may be shown again.
    Backoff(u64),
}

impl Answer {
    pub fn wire(&self) -> String {
        match self {
            Self::Accepted => "accepted".into(),
            Self::Declined => "declined".into(),
            Self::Backoff(seconds) => format!("backoff:{seconds}"),
        }
    }
}

/// Ask the person with `ask` (true: they agreed), unless they refused
/// recently. Computer use is paused for as long as `ask` runs.
pub fn confirm_with(ask: impl FnOnce() -> bool) -> Answer {
    confirm_at(Instant::now(), ask)
}

fn confirm_at(now: Instant, ask: impl FnOnce() -> bool) -> Answer {
    if let Some(until) = refusals().lock().unwrap().until {
        if until > now {
            return Answer::Backoff(until.duration_since(now).as_secs().max(1));
        }
    }
    let agreed = {
        let _open = Confirming::begin();
        ask()
    };
    let mut refusals = refusals().lock().unwrap();
    if agreed {
        *refusals = Refusals::default();
        return Answer::Accepted;
    }
    refusals.strikes = refusals.strikes.saturating_add(1);
    let wait = BACKOFF_FIRST.saturating_mul(1 << (refusals.strikes - 1).min(4)).min(BACKOFF_MAX);
    refusals.until = Some(now + wait);
    Answer::Declined
}

fn setting_path() -> Option<std::path::PathBuf> {
    crate::store::root().ok().map(|root| root.join(SETTING_FILE))
}

fn enabled_at(path: &std::path::Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Whether the person lets the command line use cloud workspaces. Off unless the file says on.
pub fn enabled() -> bool {
    setting_path().is_some_and(|path| enabled_at(&path))
}

fn write_enabled(path: &std::path::Path, enabled: bool) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        crate::store::ensure_dir(dir.to_path_buf()).map_err(|_| "cloud_control_setting_unwritable".to_string())?;
    }
    crate::store::write_atomic(path, json!({ "enabled": enabled }).to_string().as_bytes()).map_err(|_| "cloud_control_setting_unwritable".to_string())
}

/// Store the switch. Turning it on is the caller's to confirm with the person first.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    write_enabled(&setting_path().ok_or_else(|| "cloud_control_setting_unwritable".to_string())?, enabled)
}

/// The refusal of a `cloud.*` command while the switch is off, before the window is asked anything.
pub fn disabled_error() -> ControlError {
    ControlError::new(
        "cloud_control_disabled",
        "Cloud workspaces cannot be used from the command line until that is turned on in TerminalX.",
        Some("In TerminalX, open Settings and turn on \"Let agents in local sessions control cloud workspaces\".".to_string()),
    )
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
        assert_eq!(timeout_for("wait", &json!({ "timeoutSeconds": 10 })), Duration::from_secs(30));
        // However long the caller asks for, one call is one short wait.
        assert_eq!(timeout_for("wait", &json!({ "timeoutSeconds": u64::MAX })), Duration::from_secs(WAIT_CHUNK_SECONDS + 20));
    }

    #[test]
    fn the_switch_is_off_until_its_file_says_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(SETTING_FILE);
        assert!(!enabled_at(&path));
        write_enabled(&path, true).unwrap();
        assert!(enabled_at(&path));
        write_enabled(&path, false).unwrap();
        assert!(!enabled_at(&path));
        // Anything but a plain `true` is off.
        for junk in ["", "{", r#"{"enabled":"yes"}"#, r#"{"enabled":1}"#, "true"] {
            std::fs::write(&path, junk).unwrap();
            assert!(!enabled_at(&path), "{junk}");
        }
    }

    #[test]
    fn a_question_pauses_computer_use_while_it_is_open_and_backs_off_after_a_refusal() {
        // One test: the question state is process-wide.
        *refusals().lock().unwrap() = Refusals::default();
        let start = Instant::now();
        assert!(!confirming());
        // Open: computer use is paused. Closed again afterwards, whatever the answer.
        assert_eq!(confirm_at(start, || { assert!(confirming()); true }), Answer::Accepted);
        assert!(!confirming());

        // Refused: the next request is not shown at all for a minute...
        assert_eq!(confirm_at(start, || false), Answer::Declined);
        let mut asked = false;
        assert_eq!(confirm_at(start + Duration::from_secs(10), || { asked = true; true }), Answer::Backoff(50));
        assert!(!asked);
        // ...and a second refusal doubles the wait.
        assert_eq!(confirm_at(start + Duration::from_secs(61), || false), Answer::Declined);
        assert!(matches!(confirm_at(start + Duration::from_secs(61 + 100), || true), Answer::Backoff(_)));
        assert_eq!(confirm_at(start + Duration::from_secs(61 + 121), || true), Answer::Accepted);
        // Agreeing clears the count: the next refusal waits a minute again.
        assert_eq!(confirm_at(start + Duration::from_secs(200), || false), Answer::Declined);
        assert_eq!(confirm_at(start + Duration::from_secs(261), || true), Answer::Accepted);

        // It never grows past fifteen minutes.
        let mut now = start + Duration::from_secs(1_000);
        for _ in 0..12 {
            assert_eq!(confirm_at(now, || false), Answer::Declined);
            now += BACKOFF_MAX + Duration::from_secs(1);
        }
        assert_eq!(confirm_at(now, || true), Answer::Accepted);
        assert_eq!(Answer::Backoff(7).wire(), "backoff:7");
        *refusals().lock().unwrap() = Refusals::default();
    }
}
