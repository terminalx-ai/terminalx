//! OpenCode: a local HTTP server (`opencode serve`) with a server-sent event
//! stream. The session manager runs the server as the tab's child, pumps
//! `/event` into this state machine as lines, and performs the HTTP requests
//! this module asks for, feeding each reply back as a synthetic line tagged
//! `raccoon_http`. Everything here is pure, so it is tested on fixtures.
//!
//! Built against the documented API (sessions, `/session/:id/message`,
//! `/session/:id/abort`, `/session/:id/permissions/:id`, `/event`) and
//! checked against a live `opencode serve` 1.19.0 (#427): the files under
//! `fixtures/` are its event stream as recorded, around a turn, an abort, an
//! abort with a message queued behind it and an abort with a permission
//! request open. What that server does that the documentation does not say:
//!
//! - **Every idle is said twice**, as `session.status` and then as the older
//!   `session.idle`. After an abort both are said again a moment later, once
//!   the aborted request has unwound, unless a new prompt is running by then.
//! - **A turn's events outlive it.** The aborted reply's last text and its
//!   message record arrive after the idle that ended the turn, so in the
//!   middle of the next turn when a message was queued.
//! - **The prompt comes back** as a text part of the reader's own message.
//!
//! So a turn ends once (`idle`), and only what belongs to it is drawn
//! (`belongs`).

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::events::*;
use crate::harness::settings::Signal;
pub use crate::harness::Action;

pub struct SpawnPlan {
    pub program: std::path::PathBuf,
    pub args: Vec<String>,
    pub port: u16,
}

/// A free loopback port, then the server pinned to it.
pub fn spawn_plan() -> Option<SpawnPlan> {
    let program = crate::binpath::resolve("opencode")?;
    let port = std::net::TcpListener::bind("127.0.0.1:0").ok()?.local_addr().ok()?.port();
    Some(SpawnPlan {
        program,
        args: vec!["serve".into(), "--hostname".into(), "127.0.0.1".into(), "--port".into(), port.to_string()],
        port,
    })
}

fn tool_type(tool: &str) -> ToolType {
    match tool {
        "bash" => ToolType::Shell,
        "read" => ToolType::FileRead,
        "edit" | "patch" | "multiedit" => ToolType::FileEdit,
        "write" => ToolType::FileWrite,
        "grep" | "glob" | "list" | "ls" => ToolType::Search,
        "webfetch" | "websearch" => ToolType::Web,
        "todowrite" | "todoread" | "plan" => ToolType::Plan,
        "task" => ToolType::SubagentSpawn,
        _ => ToolType::Other,
    }
}

fn block(id: &str) -> BlockRef {
    BlockRef { message_id: id.into(), index: 0 }
}

#[derive(Default)]
pub struct OpenCode {
    pub base: String,
    pub session_id: Option<String>,
    pub ready: bool,
    stashed: Option<(String, Vec<(String, String)>)>,
    pub model: Option<String>,
    pub mode: String,
    resume: Option<String>,
    /// Text seen so far per part, to turn full-text updates into deltas.
    seen: HashMap<String, String>,
    committed: HashMap<String, bool>,
    tools_started: HashMap<String, bool>,
    /// Open permission requests: our request id → the server's permission id.
    asks: HashMap<String, String>,
    turn_open: bool,
    /// The app asked for the open turn to be aborted (`interrupt`): its idle
    /// is a stopped turn, not a finished one.
    aborting: bool,
    /// The server has shown it is working on the open turn (it said busy, or
    /// sent some of the reply). Until then an idle is the previous turn's.
    acknowledged: bool,
    /// This server reports `session.status`; its `session.idle` is the same
    /// news a second time.
    reports_status: bool,
    /// The reader's own messages: their parts are the prompt, not a reply.
    prompts: HashSet<String>,
    /// The messages of the open turn, and of the turns before it. What still
    /// arrives for an earlier turn's message is not part of this one.
    messages: HashSet<String>,
    retired: HashSet<String>,
    turn_started_at: Option<std::time::Instant>,
    last_usage: Option<(u64, Option<u64>)>,
}

impl OpenCode {
    /// The server runs in the session's checkout already, so the cwd is
    /// implied; it is accepted here so every engine is built the same way.
    pub fn new(port: u16, _cwd: &str, resume: Option<String>, model: Option<String>, mode: &str) -> Self {
        Self { base: format!("http://127.0.0.1:{port}"), resume, model, mode: mode.into(), ..Default::default() }
    }

    fn http(&self, tag: &str, method: &str, path: &str, body: Option<Value>) -> Action {
        Action::Http { tag: tag.into(), method: method.into(), url: format!("{}{}", self.base, path), body }
    }

    /// The first prompt waits for a session; resume asks for the old one first.
    pub fn start(&mut self, text: String, images: Vec<(String, String)>) -> Vec<Action> {
        self.stashed = Some((text, images));
        vec![self.open_session()]
    }

    fn open_session(&self) -> Action {
        match &self.resume {
            Some(id) => self.http("session_get", "GET", &format!("/session/{id}"), None),
            None => self.http("session_new", "POST", "/session", Some(json!({}))),
        }
    }

    fn begin_turn(&mut self, text: &str, images: &[(String, String)]) -> Vec<Action> {
        let sid = self.session_id.clone().unwrap_or_default();
        let mut parts = vec![json!({"type": "text", "text": text})];
        for (i, (media, data)) in images.iter().enumerate() {
            parts.push(json!({"type": "file", "mime": media, "filename": format!("image-{}.{}", i + 1, media.rsplit('/').next().unwrap_or("png")), "url": format!("data:{media};base64,{data}")}));
        }
        let mut body = json!({"parts": parts, "agent": if self.mode == "plan" { "plan" } else { "build" }});
        if let Some(m) = self.model.as_deref().filter(|m| m.contains('/')) {
            let (provider, model) = m.split_once('/').unwrap();
            body["model"] = json!({"providerID": provider, "modelID": model});
        }
        self.turn_open = true;
        self.aborting = false;
        self.acknowledged = false;
        self.turn_started_at = Some(std::time::Instant::now());
        self.seen.clear();
        self.committed.clear();
        vec![
            Action::Emit(Payload::TurnStarted { model: self.model.clone(), provider_session_id: self.session_id.clone(), prompt_seq: None }),
            Action::Emit(Payload::ModelRequestStarted),
            self.http("prompt", "POST", &format!("/session/{sid}/message"), Some(body)),
        ]
    }

    pub fn prompt(&mut self, text: String, images: Vec<(String, String)>) -> Vec<Action> {
        if !self.ready {
            self.stashed = Some((text, images));
            return Vec::new();
        }
        self.begin_turn(&text, &images)
    }

    /// Abort the open turn; the server keeps running. The turn ends when the
    /// session goes idle (`idle`), not here.
    pub fn interrupt(&mut self) -> Vec<Action> {
        if !self.turn_open {
            return Vec::new();
        }
        match &self.session_id {
            Some(sid) => {
                self.aborting = true;
                vec![self.http("abort", "POST", &format!("/session/{sid}/abort"), Some(json!({})))]
            }
            None => Vec::new(),
        }
    }

    /// The session has nothing running: the open turn is over. It is a
    /// stopped turn when the app asked for the abort.
    ///
    /// An idle heard before the server has taken the open turn up is about
    /// the turn before it: an abort is followed by a second idle once the
    /// aborted request has unwound, and a queued message may have started a
    /// turn by then.
    fn idle(&mut self) -> Vec<Action> {
        if self.turn_open && self.reports_status && !self.acknowledged {
            return Vec::new();
        }
        let status = if std::mem::take(&mut self.aborting) { TurnStatus::Aborted } else { TurnStatus::Ok };
        self.end_turn(status, None, false)
    }

    /// Whether what the server says about `message` is part of the open
    /// turn's reply, noting the message as this turn's when it is. Not the
    /// reader's own message, and not one from a turn that has ended. A
    /// server that names no message is taken at its word.
    fn belongs(&mut self, message: &Value) -> bool {
        let Some(id) = message.as_str() else { return true };
        if self.prompts.contains(id) || self.retired.contains(id) {
            return false;
        }
        if self.turn_open {
            self.messages.insert(id.to_string());
            self.acknowledged = true;
        }
        true
    }

    pub fn answer(&mut self, request_id: &str, option_id: &str) -> Option<Vec<Action>> {
        let pid = self.asks.remove(request_id)?;
        let sid = self.session_id.clone().unwrap_or_default();
        let response = match option_id {
            "always" => "always",
            "once" => "once",
            _ => "reject",
        };
        Some(vec![self.http("permission", "POST", &format!("/session/{sid}/permissions/{pid}"), Some(json!({"response": response})))])
    }

    #[cfg(test)]
    pub fn has_ask(&self, request_id: &str) -> bool {
        self.asks.contains_key(request_id)
    }

    fn end_turn(&mut self, status: TurnStatus, final_text: Option<String>, auth_failed: bool) -> Vec<Action> {
        if !self.turn_open {
            return Vec::new();
        }
        self.turn_open = false;
        // What it was asking went with it, and whatever still arrives for its messages is late.
        self.asks.clear();
        self.retired.extend(self.messages.drain());
        let duration_ms = self.turn_started_at.take().map(|t| t.elapsed().as_millis() as u64);
        let usage = self.last_usage.map(|(used, max)| Usage { context_used: Some(used), context_max: max, ..Default::default() });
        let mut out = self.commit_open_text();
        out.push(Action::Emit(Payload::TurnCompleted { status, final_text, usage, duration_ms, head: None, auth_failed }));
        out
    }

    /// Any text part still streaming when the turn ends becomes a block.
    fn commit_open_text(&mut self) -> Vec<Action> {
        let mut out = Vec::new();
        let open: Vec<(String, String)> = self.seen.iter().filter(|(id, _)| !self.committed.get(*id).copied().unwrap_or(false)).map(|(a, b)| (a.clone(), b.clone())).collect();
        for (id, text) in open {
            if text.is_empty() {
                continue;
            }
            self.committed.insert(id.clone(), true);
            if id.starts_with("r:") {
                out.push(Action::Emit(Payload::Reasoning { block: Some(block(&id)), text }));
            } else {
                out.push(Action::Emit(Payload::AssistantText { block: Some(block(&id)), text }));
            }
        }
        out
    }

    pub fn handle(&mut self, line: &str) -> Vec<Action> {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        if let Some(h) = v.get("raccoon_http") {
            let tag = h["tag"].as_str().unwrap_or("").to_string();
            let status = h["status"].as_u64().unwrap_or(0);
            return self.on_http(&tag, status, &h["body"]);
        }
        let kind = v["type"].as_str().unwrap_or("").to_string();
        self.on_event(&kind, &v["properties"])
    }

    fn on_http(&mut self, tag: &str, status: u64, body: &Value) -> Vec<Action> {
        let ok = (200..300).contains(&status);
        let message = body.pointer("/error/message").or_else(|| body.get("message")).and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| body.as_str().map(String::from).unwrap_or_else(|| format!("HTTP {status}")));
        match tag {
            "session_get" if !ok => {
                self.resume = None;
                vec![
                    Action::Emit(Payload::Status { text: "The previous OpenCode session could not be resumed; starting a new one.".into() }),
                    self.open_session(),
                ]
            }
            "session_new" | "session_get" => {
                if !ok {
                    self.turn_open = true;
                    return self.end_turn(TurnStatus::Error, Some(message), status == 401 || status == 403);
                }
                let mut out = Vec::new();
                if let Some(id) = body["id"].as_str() {
                    self.session_id = Some(id.into());
                    out.push(Action::ThreadReady(id.into()));
                }
                self.ready = true;
                if let Some((text, images)) = self.stashed.take() {
                    out.extend(self.begin_turn(&text, &images));
                }
                out
            }
            "prompt" if !ok => self.end_turn(TurnStatus::Error, Some(message), status == 401 || status == 403),
            "prompt" => {
                // The synchronous reply lands after the stream has already
                // reported the turn; only an error path needs it.
                Vec::new()
            }
            // The server did not take the abort: the turn goes on, and its end is its own.
            "abort" if !ok => {
                self.aborting = false;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn on_event(&mut self, kind: &str, p: &Value) -> Vec<Action> {
        let mine = |sid: &Value| self.session_id.is_none() || sid.is_null() || sid.as_str() == self.session_id.as_deref();
        match kind {
            "message.part.updated" => {
                let part = &p["part"];
                if !mine(&part["sessionID"]) || !self.belongs(&part["messageID"]) {
                    return Vec::new();
                }
                self.on_part(part)
            }
            "message.part.delta" => {
                if !mine(&p["sessionID"]) || !self.belongs(&p["messageID"]) {
                    return Vec::new();
                }
                let id = p["partID"].as_str().unwrap_or("").to_string();
                let delta = p["delta"].as_str().unwrap_or("").to_string();
                let key = if p["field"].as_str() == Some("reasoning") || id.starts_with("r:") { format!("r:{id}") } else { id.clone() };
                self.seen.entry(key.clone()).or_default().push_str(&delta);
                if key.starts_with("r:") {
                    vec![Action::Emit(Payload::Delta(Delta::ThinkingDelta { block: block(&key), text: delta }))]
                } else {
                    vec![Action::Emit(Payload::Delta(Delta::TextDelta { block: block(&key), text: delta }))]
                }
            }
            // Each reply says which model wrote it. A tab that named a model
            // sends it with every prompt, so its replies have nothing to
            // add — and one still arriving from before a change would undo
            // that change. A tab that named none learns here what the
            // server chose (#404).
            "message.updated" => {
                let info = &p["info"];
                if !mine(&info["sessionID"]) {
                    return Vec::new();
                }
                if info["role"].as_str() == Some("user") {
                    if let Some(id) = info["id"].as_str() {
                        self.prompts.insert(id.to_string());
                    }
                    return Vec::new();
                }
                if info["role"].as_str() != Some("assistant") || !self.belongs(&info["id"]) || self.model.is_some() {
                    return Vec::new();
                }
                let (Some(provider), Some(model)) = (info["providerID"].as_str(), info["modelID"].as_str()) else { return Vec::new() };
                // Not adopted as the model to send: the tab goes on following the server's choice.
                Signal::current(Some(&format!("{provider}/{model}")), None).map(|signal| Action::Emit(Payload::ProviderSettings { signal })).into_iter().collect()
            }
            // The older word for idle. A server that reports `session.status`
            // has said it there already; this one would end the turn a queued
            // message started in between.
            "session.idle" => {
                if !mine(&p["sessionID"]) || self.reports_status {
                    return Vec::new();
                }
                self.idle()
            }
            "session.status" => {
                if !mine(&p["sessionID"]) {
                    return Vec::new();
                }
                self.reports_status = true;
                if p["status"]["type"].as_str() == Some("idle") {
                    self.idle()
                } else {
                    self.acknowledged |= self.turn_open;
                    Vec::new()
                }
            }
            "session.error" => {
                if !mine(&p["sessionID"]) {
                    return Vec::new();
                }
                let name = p["error"]["name"].as_str().unwrap_or("");
                let message = p["error"]["data"]["message"].as_str().or_else(|| p["error"]["message"].as_str()).unwrap_or("OpenCode reported an error").to_string();
                let auth = name.to_lowercase().contains("auth") || message.to_lowercase().contains("api key");
                // An abort is reported twice, as this error and as the
                // session's idle, in an order the server does not promise.
                // The idle is the one that ends the turn: whichever of the
                // two came second would otherwise end the turn after it, when
                // a queued message has started one in between (#427).
                if name == "MessageAbortedError" {
                    Vec::new()
                } else {
                    self.end_turn(TurnStatus::Error, Some(message), auth)
                }
            }
            "permission.updated" | "permission.asked" => {
                if !mine(&p["sessionID"]) {
                    return Vec::new();
                }
                let id = p["id"].as_str().unwrap_or("").to_string();
                let request_id = format!("oc:{id}");
                self.asks.insert(request_id.clone(), id);
                // 1.19 names the tool `permission`, puts the call under `tool` and lists `patterns`.
                let tool = p["type"].as_str().or_else(|| p["permission"].as_str()).unwrap_or("tool").to_string();
                let patterns = p["patterns"].as_array().map(|list| list.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).filter(|list| !list.is_empty());
                let mut out = self.commit_open_text();
                out.push(Action::Emit(Payload::PermissionRequested {
                    request_id,
                    tool_use_id: p["callID"].as_str().or_else(|| p["tool"]["callID"].as_str()).unwrap_or("").into(),
                    tool_name: tool,
                    input: p["metadata"].clone(),
                    title: p["title"].as_str().map(String::from),
                    description: p["pattern"].as_str().map(String::from).or(patterns).map(|s| format!("Pattern: {s}")),
                    options: vec![
                        PermissionOption { id: "once".into(), label: "Allow once".into(), kind: PermissionOptionKind::AllowOnce },
                        PermissionOption { id: "always".into(), label: "Always allow".into(), kind: PermissionOptionKind::AllowAlways },
                        PermissionOption { id: "reject".into(), label: "Deny".into(), kind: PermissionOptionKind::Deny },
                    ],
                }));
                out
            }
            "permission.replied" => {
                let id = p["permissionID"].as_str().or_else(|| p["requestID"].as_str()).or_else(|| p["id"].as_str()).unwrap_or("");
                self.asks.retain(|_, v| v != id);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn on_part(&mut self, part: &Value) -> Vec<Action> {
        let id = part["id"].as_str().unwrap_or("").to_string();
        match part["type"].as_str().unwrap_or("") {
            "text" | "reasoning" => {
                let reasoning = part["type"] == "reasoning";
                let key = if reasoning { format!("r:{id}") } else { id.clone() };
                let full = part["text"].as_str().unwrap_or("").to_string();
                let prev = self.seen.get(&key).cloned().unwrap_or_default();
                let mut out = Vec::new();
                if full.len() > prev.len() && full.starts_with(&prev) {
                    let delta = full[prev.len()..].to_string();
                    out.push(Action::Emit(if reasoning {
                        Payload::Delta(Delta::ThinkingDelta { block: block(&key), text: delta })
                    } else {
                        Payload::Delta(Delta::TextDelta { block: block(&key), text: delta })
                    }));
                }
                self.seen.insert(key.clone(), full.clone());
                let finished = !part["time"]["end"].is_null();
                if finished && !self.committed.get(&key).copied().unwrap_or(false) && !full.is_empty() {
                    self.committed.insert(key.clone(), true);
                    out.push(Action::Emit(if reasoning {
                        Payload::Reasoning { block: Some(block(&key)), text: full }
                    } else {
                        Payload::AssistantText { block: Some(block(&key)), text: full }
                    }));
                }
                out
            }
            "tool" => {
                let call_id = part["callID"].as_str().unwrap_or(&id).to_string();
                let tool = part["tool"].as_str().unwrap_or("tool").to_string();
                let state = &part["state"];
                let status = state["status"].as_str().unwrap_or("pending");
                let mut out = Vec::new();
                if !self.tools_started.get(&call_id).copied().unwrap_or(false) {
                    self.tools_started.insert(call_id.clone(), true);
                    out.extend(self.commit_open_text());
                    out.push(Action::Emit(Payload::ToolCallStarted {
                        call_id: call_id.clone(),
                        name: tool.clone(),
                        tool_type: tool_type(&tool),
                        input: state["input"].clone(),
                        title: state["title"].as_str().map(String::from),
                    }));
                }
                if status == "completed" || status == "error" {
                    let is_error = status == "error";
                    let text = state["output"].as_str().or_else(|| state["error"].as_str()).unwrap_or("").to_string();
                    out.push(Action::Emit(Payload::ToolCallCompleted { call_id, result: ToolResult { text, is_error, ..Default::default() } }));
                    out.push(Action::Emit(Payload::ModelRequestStarted));
                }
                out
            }
            "step-finish" => {
                let t = &part["tokens"];
                let used = t["input"].as_u64().unwrap_or(0) + t["output"].as_u64().unwrap_or(0) + t["cache"]["read"].as_u64().unwrap_or(0);
                if used > 0 {
                    self.last_usage = Some((used, None));
                    vec![Action::Emit(Payload::UsageUpdate(Usage { context_used: Some(used), ..Default::default() }))]
                } else {
                    Vec::new()
                }
            }
            _ => Vec::new(),
        }
    }
}

/// How long a server that was just started is given to begin listening.
const STARTUP_WAIT: std::time::Duration = std::time::Duration::from_secs(120);

/// Reads `/event` and hands each `data:` payload to `emit`, reconnecting
/// while `alive` says the server should still be there. Returns when the
/// server is gone.
pub fn pump_events(base: &str, alive: impl Fn() -> bool, emit: impl Fn(String)) {
    use std::io::{BufRead, BufReader};
    let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(2)).build();
    // Wait for the server to answer at all.
    let started = std::time::Instant::now();
    while alive() && started.elapsed() < STARTUP_WAIT {
        if agent.get(&format!("{base}/session")).call().is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    if !alive() {
        return;
    }
    if started.elapsed() >= STARTUP_WAIT {
        emit(json!({"type": "session.error", "properties": {"error": {"name": "StartupError", "data": {"message": "The OpenCode server did not start within two minutes."}}}}).to_string());
        return;
    }
    while alive() {
        let Ok(resp) = agent.get(&format!("{base}/event")).call() else {
            std::thread::sleep(std::time::Duration::from_millis(800));
            continue;
        };
        let reader = BufReader::new(resp.into_reader());
        for line in reader.lines().map_while(Result::ok) {
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() {
                    emit(data.to_string());
                }
            }
            if !alive() {
                return;
            }
        }
    }
}

/// One request, blocking; the reply becomes a line the engine understands.
///
/// The first request of a tab, the one that opens its session, is made the
/// moment its server is spawned, and a server takes a second or so to start
/// listening. A refused connection is therefore tried again for as long as
/// the event pump waits for the server. It used to be the answer, and the
/// first message of every tab failed with it (found by the live test, #427).
pub fn perform(tag: &str, method: &str, url: &str, body: Option<Value>) -> String {
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(600)).build();
    let started = std::time::Instant::now();
    let (status, body) = loop {
        let req = agent.request(method, url);
        let resp = match &body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };
        match resp {
            Ok(r) => {
                let status = r.status() as u64;
                let text = r.into_string().unwrap_or_default();
                break (status, serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)));
            }
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                break (code as u64, serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)));
            }
            Err(ureq::Error::Transport(e)) if e.kind() == ureq::ErrorKind::ConnectionFailed && started.elapsed() < STARTUP_WAIT => {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => break (0, Value::String(e.to_string())),
        }
    };
    json!({"raccoon_http": {"tag": tag, "status": status, "body": body}}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emits(actions: &[Action]) -> Vec<&Payload> {
        actions.iter().filter_map(|a| if let Action::Emit(p) = a { Some(p) } else { None }).collect()
    }
    fn https(actions: &[Action]) -> Vec<(String, String, Option<Value>)> {
        actions.iter().filter_map(|a| if let Action::Http { tag, url, body, .. } = a { Some((tag.clone(), url.clone(), body.clone())) } else { None }).collect()
    }

    #[test]
    fn opens_a_session_then_prompts_with_agent_and_model() {
        let mut o = OpenCode::new(4321, "/tmp/x", None, Some("anthropic/claude-sonnet-4".into()), "plan");
        let acts = o.start("hi".into(), vec![]);
        assert_eq!(https(&acts)[0].0, "session_new");
        let acts = o.handle(r#"{"raccoon_http":{"tag":"session_new","status":200,"body":{"id":"ses_1","title":"New"}}}"#);
        assert!(matches!(acts[0], Action::ThreadReady(ref s) if s == "ses_1"));
        let (tag, url, body) = https(&acts).into_iter().next().unwrap();
        assert_eq!(tag, "prompt");
        assert!(url.ends_with("/session/ses_1/message"));
        let body = body.unwrap();
        assert_eq!(body["agent"], "plan");
        assert_eq!(body["model"]["providerID"], "anthropic");
        assert_eq!(body["parts"][0]["text"], "hi");
    }

    /// #404. A reply names the model that wrote it: news for a tab that
    /// named none, and nothing new for one whose prompt asked for it.
    #[test]
    fn a_reply_says_which_model_wrote_it() {
        let reply = |session: &str, role: &str| json!({"type":"message.updated","properties":{"info":{"id":"m1","sessionID":session,"role":role,"providerID":"anthropic","modelID":"claude-sonnet-4"}}}).to_string();
        let signals = |acts: &[Action]| -> Vec<Signal> { emits(acts).into_iter().filter_map(|p| if let Payload::ProviderSettings { signal } = p { Some(signal.clone()) } else { None }).collect() };

        let mut o = OpenCode::new(1, "/tmp/x", None, None, "auto");
        o.start("x".into(), vec![]);
        o.handle(r#"{"raccoon_http":{"tag":"session_new","status":200,"body":{"id":"s"}}}"#);
        assert_eq!(signals(&o.handle(&reply("s", "assistant"))), [Signal::Current { model: Some("anthropic/claude-sonnet-4".into()), effort: None }]);
        // The reader's own message and another session's reply say nothing.
        assert!(o.handle(&reply("s", "user")).is_empty());
        assert!(o.handle(&reply("other", "assistant")).is_empty());

        // A tab that named its model is not moved by a reply, least of all
        // by one still arriving from before the model was changed.
        let mut o = OpenCode::new(1, "/tmp/x", None, Some("openai/gpt-5".into()), "auto");
        o.start("x".into(), vec![]);
        o.handle(r#"{"raccoon_http":{"tag":"session_new","status":200,"body":{"id":"s"}}}"#);
        assert!(o.handle(&reply("s", "assistant")).is_empty());
    }

    #[test]
    fn full_text_updates_become_deltas_then_a_block_and_idle_ends_the_turn() {
        let mut o = OpenCode::new(1, "/tmp/x", None, None, "auto");
        o.start("x".into(), vec![]);
        o.handle(r#"{"raccoon_http":{"tag":"session_new","status":200,"body":{"id":"s"}}}"#);
        let a = o.handle(r#"{"type":"message.part.updated","properties":{"part":{"id":"p1","sessionID":"s","type":"text","text":"Hel"}}}"#);
        assert!(matches!(emits(&a)[0], Payload::Delta(Delta::TextDelta { text, .. }) if text == "Hel"));
        let a = o.handle(r#"{"type":"message.part.updated","properties":{"part":{"id":"p1","sessionID":"s","type":"text","text":"Hello","time":{"start":1,"end":2}}}}"#);
        let e = emits(&a);
        assert!(matches!(e[0], Payload::Delta(Delta::TextDelta { text, .. }) if text == "lo"));
        assert!(matches!(e[1], Payload::AssistantText { text, .. } if text == "Hello"));
        let a = o.handle(r#"{"type":"session.idle","properties":{"sessionID":"s"}}"#);
        assert!(matches!(emits(&a)[0], Payload::TurnCompleted { status: TurnStatus::Ok, .. }));
        // A second idle is silent: the turn is already closed.
        assert!(o.handle(r#"{"type":"session.idle","properties":{"sessionID":"s"}}"#).is_empty());
    }

    #[test]
    fn tools_and_permissions() {
        let mut o = OpenCode::new(1, "/tmp/x", None, None, "auto");
        o.start("x".into(), vec![]);
        o.handle(r#"{"raccoon_http":{"tag":"session_new","status":200,"body":{"id":"s"}}}"#);
        let a = o.handle(r#"{"type":"message.part.updated","properties":{"part":{"id":"p2","sessionID":"s","type":"tool","callID":"c1","tool":"bash","state":{"status":"running","input":{"command":"ls"},"title":"ls"}}}}"#);
        assert!(matches!(emits(&a)[0], Payload::ToolCallStarted { tool_type: ToolType::Shell, .. }));
        let a = o.handle(r#"{"type":"permission.updated","properties":{"id":"perm1","sessionID":"s","type":"bash","title":"Run ls","callID":"c1","metadata":{"command":"ls"}}}"#);
        let Payload::PermissionRequested { request_id, options, .. } = emits(&a)[0] else { panic!() };
        assert_eq!(options.len(), 3);
        let reply = https(&o.answer(request_id, "once").unwrap());
        assert!(reply[0].1.ends_with("/session/s/permissions/perm1"));
        assert_eq!(reply[0].2.as_ref().unwrap()["response"], "once");
        assert!(!o.has_ask(request_id));
        let a = o.handle(r#"{"type":"message.part.updated","properties":{"part":{"id":"p2","sessionID":"s","type":"tool","callID":"c1","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"a\nb"}}}}"#);
        assert!(matches!(emits(&a)[0], Payload::ToolCallCompleted { result, .. } if result.text == "a\nb" && !result.is_error));
    }

    #[test]
    fn a_lost_session_starts_fresh_and_errors_end_the_turn() {
        let mut o = OpenCode::new(1, "/tmp/x", Some("old".into()), None, "auto");
        let acts = o.start("x".into(), vec![]);
        assert!(https(&acts)[0].1.ends_with("/session/old"));
        let acts = o.handle(r#"{"raccoon_http":{"tag":"session_get","status":404,"body":{"error":{"message":"not found"}}}}"#);
        assert_eq!(https(&acts)[0].0, "session_new");
        o.handle(r#"{"raccoon_http":{"tag":"session_new","status":200,"body":{"id":"s2"}}}"#);
        let a = o.handle(r#"{"type":"session.error","properties":{"sessionID":"s2","error":{"name":"ProviderAuthError","data":{"message":"Invalid API key"}}}}"#);
        assert!(matches!(emits(&a)[0], Payload::TurnCompleted { status: TurnStatus::Error, auth_failed: true, .. }));
    }

    /// The request that opens a tab's session is made as its server is
    /// spawned: it waits for the server to listen instead of failing.
    #[test]
    fn a_request_waits_for_a_server_that_is_still_starting() {
        use std::io::{Read, Write};
        // A port nothing listens on yet.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let body = r#"{"id":"ses_1"}"#;
            write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let line: Value = serde_json::from_str(&perform("session_new", "POST", &format!("http://127.0.0.1:{port}/session"), Some(json!({})))).unwrap();
        server.join().unwrap();
        assert_eq!(line["raccoon_http"], json!({ "tag": "session_new", "status": 200, "body": { "id": "ses_1" } }));
    }

    // ---- #427: Escape for a running turn, against a live server's own words

    /// What `opencode serve` 1.19.0 said, recorded with a model that streams
    /// one word a second (see the module's notes on what it does).
    const TURN: &str = include_str!("fixtures/turn.jsonl");
    const ABORT: &str = include_str!("fixtures/abort.jsonl");
    const ABORT_THEN_NEXT: &str = include_str!("fixtures/abort_then_next.jsonl");
    const PERMISSION_ABORT: &str = include_str!("fixtures/permission_abort.jsonl");
    const PERMISSION_REJECT_ABORT: &str = include_str!("fixtures/permission_reject_abort.jsonl");

    /// Run a recording through the engine the way the session manager drives
    /// it: the server's lines in order, an abort (and a rejection) where the
    /// recording made one, and the next of `queued` as a prompt the moment a
    /// turn ends. Returns the chat as it is told, each turn's streamed text
    /// just before its end, and what the engine asked of the server.
    fn replay(recording: &str, queued: &[&str]) -> (OpenCode, Vec<String>, Vec<String>) {
        let lines: Vec<Value> = recording.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let first = lines.iter().find(|line| line["probe"] == "prompt").unwrap()["text"].as_str().unwrap().to_string();
        let mut queue: std::collections::VecDeque<String> = queued.iter().map(|text| text.to_string()).collect();
        let (mut told, mut asked, mut streamed) = (Vec::new(), Vec::new(), String::new());
        let mut o = OpenCode::new(1, "/w/proj", None, None, "auto");
        let mut pending = o.start(first, vec![]);
        let mut next = lines.iter();
        loop {
            for action in std::mem::take(&mut pending) {
                match action {
                    Action::Http { tag, body, .. } => asked.push(match tag.as_str() {
                        "prompt" => format!("prompt: {}", body.unwrap()["parts"][0]["text"].as_str().unwrap()),
                        _ => tag,
                    }),
                    Action::Emit(Payload::TurnStarted { .. }) => told.push("start".to_string()),
                    Action::Emit(Payload::Delta(Delta::TextDelta { text, .. })) => streamed.push_str(&text),
                    Action::Emit(Payload::AssistantText { text, .. }) => told.push(format!("text: {text}")),
                    Action::Emit(Payload::ToolCallStarted { name, .. }) => told.push(format!("tool: {name}")),
                    Action::Emit(Payload::ToolCallCompleted { result, .. }) => told.push(format!("tool ended: {}", if result.is_error { "error" } else { "ok" })),
                    Action::Emit(Payload::PermissionRequested { tool_name, description, .. }) => told.push(format!("ask: {tool_name} ({})", description.unwrap_or_default())),
                    Action::Emit(Payload::TurnCompleted { status, .. }) => {
                        told.push(format!("streamed: {}", std::mem::take(&mut streamed)));
                        told.push(format!("end: {status:?}"));
                        // The session manager sends the next queued message here, before it hears anything more.
                        if let Some(text) = queue.pop_front() {
                            pending.extend(o.prompt(text, vec![]));
                        }
                    }
                    _ => {}
                }
            }
            if !pending.is_empty() {
                continue;
            }
            let Some(line) = next.next() else { break };
            pending = match line["probe"].as_str() {
                // The recording's own prompts: the first is the one started above, a later one is `queued`.
                Some("prompt") => Vec::new(),
                Some("abort") => o.interrupt(),
                Some("reject") => o.answer(&format!("oc:{}", line["id"].as_str().unwrap()), "reject").expect("the request is open"),
                _ => o.handle(&line.to_string()),
            };
        }
        (o, told, asked)
    }

    /// One turn, ended once: the server says idle twice, and the prompt it
    /// echoes back as a part of the reader's message is not the reply.
    #[test]
    fn a_live_turn_ends_once_and_does_not_read_the_prompt_back() {
        assert_eq!(TURN.matches(r#""status":{"type":"idle"}"#).count(), 1, "idle, as a status");
        assert_eq!(TURN.matches(r#""type":"session.idle""#).count(), 1, "and idle again, the old way");
        assert!(TURN.contains(r#""text":"TICKS=3 say hello""#), "the prompt, as a part of the reader's message");
        let (o, told, asked) = replay(TURN, &[]);
        assert_eq!(told, ["start", "text: tick0 tick1 tick2 ", "streamed: tick0 tick1 tick2 ", "end: Ok"]);
        assert_eq!(asked, ["session_new", "prompt: TICKS=3 say hello"]);
        assert!(!o.turn_open);
    }

    /// The same turn with a message queued behind it. The second idle used
    /// to end the turn that message had just started.
    #[test]
    fn the_second_idle_of_a_finished_turn_does_not_end_the_queued_one() {
        let (o, told, asked) = replay(TURN, &["then this"]);
        assert_eq!(told, ["start", "text: tick0 tick1 tick2 ", "streamed: tick0 tick1 tick2 ", "end: Ok", "start"]);
        assert_eq!(asked, ["session_new", "prompt: TICKS=3 say hello", "prompt: then this"]);
        assert!(o.turn_open, "the queued message's turn is still running");
    }

    /// Escape: the abort is asked for, and the turn is a stopped one when the
    /// server goes idle. The error, the second pair of idles and the aborted
    /// reply's late records change nothing.
    #[test]
    fn an_interrupted_live_turn_ends_once_as_stopped() {
        assert!(ABORT.contains("MessageAbortedError"));
        let (o, told, asked) = replay(ABORT, &[]);
        assert_eq!(told, ["start", "text: tick0 tick1 tick2 tick3 tick4 ", "streamed: tick0 tick1 tick2 tick3 tick4 ", "end: Aborted"]);
        assert_eq!(asked, ["session_new", "prompt: TICKS=60 first", "abort"]);
        assert!(!o.turn_open);
    }

    /// Escape with a message queued: the stopped turn hands over to it at
    /// once, as the server allows. The queued turn is not ended by the idle
    /// the server repeats, does not get the aborted reply's last text (which
    /// arrives in the middle of it), and ends as its own, finished.
    #[test]
    fn an_interrupted_live_turn_hands_over_to_the_queued_message() {
        let (o, told, asked) = replay(ABORT_THEN_NEXT, &["TICKS=4 second"]);
        assert_eq!(
            told,
            [
                "start",
                "text: tick0 tick1 tick2 tick3 tick4 ",
                "streamed: tick0 tick1 tick2 tick3 tick4 ",
                "end: Aborted",
                "start",
                "text: tick0 tick1 tick2 tick3 ",
                "streamed: tick0 tick1 tick2 tick3 ",
                "end: Ok",
            ]
        );
        assert_eq!(asked, ["session_new", "prompt: TICKS=60 first", "abort", "prompt: TICKS=4 second"]);
        assert!(!o.turn_open);
    }

    /// Escape while the turn waits on a permission request. Aborted, the
    /// server drops the request and never runs the tool; the engine forgets
    /// the request with the turn.
    #[test]
    fn an_interrupted_live_turn_takes_its_permission_request_with_it() {
        let (o, told, asked) = replay(PERMISSION_ABORT, &[]);
        assert_eq!(told, ["start", "tool: bash", "ask: bash (Pattern: echo probe-tool-ran)", "streamed: ", "end: Aborted"]);
        assert_eq!(asked, ["session_new", "prompt: TOOL please run the marker command", "abort"]);
        assert!(o.asks.is_empty());

        // As the app does it: the request is turned down first, then the turn aborted.
        let (o, told, asked) = replay(PERMISSION_REJECT_ABORT, &[]);
        assert_eq!(told, ["start", "tool: bash", "ask: bash (Pattern: echo probe-tool-ran)", "tool ended: error", "streamed: ", "end: Aborted"]);
        assert_eq!(asked, ["session_new", "prompt: TOOL please run the marker command", "permission", "abort"]);
        assert!(o.asks.is_empty());
    }

    // ---- the same rules on a server that only says `session.idle`

    /// A tab with its session open and a turn running on `text`.
    fn working(text: &str) -> OpenCode {
        let mut o = OpenCode::new(1, "/tmp/x", None, None, "auto");
        o.start(text.into(), vec![]);
        o.handle(r#"{"raccoon_http":{"tag":"session_new","status":200,"body":{"id":"s"}}}"#);
        o
    }
    fn ends(actions: &[Action]) -> Vec<TurnStatus> {
        emits(actions).into_iter().filter_map(|p| if let Payload::TurnCompleted { status, .. } = p { Some(*status) } else { None }).collect()
    }
    const IDLE: &str = r#"{"type":"session.idle","properties":{"sessionID":"s"}}"#;
    const BUSY: &str = r#"{"type":"session.status","properties":{"sessionID":"s","status":{"type":"busy"}}}"#;
    const STATUS_IDLE: &str = r#"{"type":"session.status","properties":{"sessionID":"s","status":{"type":"idle"}}}"#;
    const ABORTED: &str = r#"{"type":"session.error","properties":{"sessionID":"s","error":{"name":"MessageAbortedError","data":{"message":"The operation was aborted."}}}}"#;

    #[test]
    fn an_interrupt_aborts_the_session_and_the_turn_ends_as_stopped_when_it_goes_idle() {
        let mut o = working("x");
        let (tag, url, _) = https(&o.interrupt()).into_iter().next().unwrap();
        assert_eq!(tag, "abort");
        assert!(url.ends_with("/session/s/abort"));
        // Asking is not the end of the turn: the server says when it has stopped.
        assert!(o.turn_open);
        assert_eq!(ends(&o.handle(IDLE)), [TurnStatus::Aborted]);
        // A turn nobody interrupted still ends as finished.
        o.prompt("y".into(), vec![]);
        assert_eq!(ends(&o.handle(IDLE)), [TurnStatus::Ok]);
    }

    /// An abort is reported as an error and as an idle, in an order the
    /// server does not promise. Only the idle ends a turn, so whichever comes
    /// second cannot end the turn a queued message started in between.
    #[test]
    fn the_second_word_about_an_abort_never_ends_the_turn_that_followed_it() {
        for order in [[IDLE, ABORTED], [ABORTED, IDLE]] {
            let mut o = working("first");
            o.interrupt();
            let mut ended = Vec::new();
            // The queued message is sent the moment the interrupted turn ends.
            for line in order {
                let now = ends(&o.handle(line));
                if !now.is_empty() {
                    assert_eq!(https(&o.prompt("second".into(), vec![]))[0].0, "prompt");
                }
                ended.extend(now);
            }
            assert_eq!(ended, [TurnStatus::Aborted], "{order:?}");
            assert!(o.turn_open, "{order:?}: the next turn is still running");
            // Its own end is its own, and it was not interrupted.
            assert_eq!(ends(&o.handle(IDLE)), [TurnStatus::Ok], "{order:?}");
        }
    }

    /// The idle a server repeats once an aborted request has unwound can
    /// reach the app after the next message was sent. Until the server has
    /// taken that message up, an idle is not about it.
    #[test]
    fn an_idle_heard_before_the_server_took_the_turn_up_is_the_turn_before() {
        let mut o = working("first");
        o.handle(BUSY);
        o.interrupt();
        assert_eq!(ends(&o.handle(STATUS_IDLE)), [TurnStatus::Aborted]);
        o.prompt("second".into(), vec![]);
        // The aborted turn's second idle, late.
        assert_eq!(ends(&o.handle(STATUS_IDLE)), []);
        assert_eq!(ends(&o.handle(IDLE)), []);
        assert!(o.turn_open);
        // The server takes the message up, and then its idle is this turn's.
        o.handle(BUSY);
        assert_eq!(ends(&o.handle(STATUS_IDLE)), [TurnStatus::Ok]);
    }

    #[test]
    fn an_interrupt_with_no_turn_or_one_the_server_refused_changes_nothing() {
        // Nothing running: nothing is asked of the server.
        let mut o = working("x");
        o.handle(IDLE);
        assert!(o.interrupt().is_empty());
        // The server did not take the abort: the turn goes on and ends as finished.
        o.prompt("y".into(), vec![]);
        assert_eq!(https(&o.interrupt())[0].0, "abort");
        o.handle(r#"{"raccoon_http":{"tag":"abort","status":500,"body":{"message":"no"}}}"#);
        assert_eq!(ends(&o.handle(IDLE)), [TurnStatus::Ok]);
    }
}
