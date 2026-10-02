//! Asks the webview what its terminals hold, and runs the terminal benchmark
//! there (issue #232, `docs/TERMINAL-PERFORMANCE.md`).
//!
//! The xterm instances, their WebGL contexts and the replay buffers live in
//! the webview, so Rust cannot count them. A request goes out as the
//! `terminal_perf_request` event and the answer comes back through the
//! `terminal_perf_reply` command. The webview does nothing until it is asked.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::sink::EventSink;

pub const REQUEST_EVENT: &str = "terminal_perf_request";
/// The benchmark opens terminals and runs commands in them, so it runs only in
/// an app launched with this set to `1`.
pub const BENCH_ENV: &str = "TERMINALX_TERMINAL_BENCH";
/// How long `terminalx status` waits for the webview's counters. A webview
/// busy enough to miss this is itself the finding; status then reports none.
pub const COUNTERS_TIMEOUT: Duration = Duration::from_millis(500);

/// Requests the webview has not answered (`None`) or whose answer nobody has read yet.
#[derive(Default)]
struct Requests {
    answers: Mutex<HashMap<String, Option<Value>>>,
    answered: Condvar,
}

fn requests() -> &'static Requests {
    static REQUESTS: OnceLock<Requests> = OnceLock::new();
    REQUESTS.get_or_init(Requests::default)
}

pub fn bench_enabled() -> bool {
    std::env::var(BENCH_ENV).is_ok_and(|value| value == "1")
}

/// Send `action` to the webview; the returned id reads its answer.
pub fn ask(sink: &dyn EventSink, action: &str, params: Value) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    requests().answers.lock().unwrap().insert(id.clone(), None);
    sink.emit(REQUEST_EVENT, &json!({ "id": id, "action": action, "params": params }));
    id
}

/// The webview's answer. One for a request nobody is waiting on is dropped.
pub fn reply(id: &str, result: Value) {
    let requests = requests();
    if let Some(answer) = requests.answers.lock().unwrap().get_mut(id) {
        *answer = Some(result);
        requests.answered.notify_all();
    }
}

/// The answer if it is there, leaving an unanswered request open. `Err` when
/// there is no such request.
pub fn poll(id: &str) -> Result<Option<Value>, ()> {
    let mut answers = requests().answers.lock().unwrap();
    match answers.get(id) {
        None => Err(()),
        Some(None) => Ok(None),
        Some(Some(_)) => Ok(answers.remove(id).flatten()),
    }
}

/// Wait for the answer; the request is closed either way.
pub fn wait(id: &str, timeout: Duration) -> Option<Value> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sink::BroadcastSink;

    #[test]
    fn an_answer_reaches_the_request_that_asked_and_no_other() {
        let sink = BroadcastSink::new(8);
        let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        let dyn_sink: &dyn EventSink = &sink;
        dyn_sink.listen(REQUEST_EVENT, Box::new(move |payload| seen.lock().unwrap().push(serde_json::from_str::<Value>(payload).unwrap())));
        let id = ask(dyn_sink, "counters", json!({}));
        assert_eq!(asked.lock().unwrap()[0], json!({ "id": id, "action": "counters", "params": {} }));
        assert_eq!(poll(&id), Ok(None));
        reply("someone-else", json!(1));
        assert_eq!(poll("someone-else"), Err(()));
        reply(&id, json!({ "instances": 2 }));
        assert_eq!(wait(&id, Duration::from_secs(5)), Some(json!({ "instances": 2 })));
        // Read once: the request is closed.
        assert_eq!(poll(&id), Err(()));
    }

    #[test]
    fn a_webview_that_does_not_answer_closes_the_request() {
        let sink = BroadcastSink::new(8);
        let id = ask(&sink, "counters", json!({}));
        assert_eq!(wait(&id, Duration::from_millis(20)), None);
        // A late answer has nowhere to go and is not kept.
        reply(&id, json!(1));
        assert_eq!(poll(&id), Err(()));
    }
}
