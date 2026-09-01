//! OpenCode: a local HTTP server (`opencode serve`) with a server-sent event
//! stream. The session manager runs the server as the tab's child, pumps
//! `/event` into this state machine as lines, and performs the HTTP requests
//! this module asks for, feeding each reply back as a synthetic line tagged
//! `raccoon_http`. Everything here is pure, so it is tested on fixtures.
//!
//! Built against the documented API (sessions, `/session/:id/message`,
//! `/session/:id/abort`, `/session/:id/permissions/:id`, `/event`). The
//! copy installed on the development machine (0.1.150) never finished
//! starting, so this has not yet been exercised against a live server.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::events::*;
pub use crate::harness::codex::Action;

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
        self.turn_started_at = Some(std::time::Instant::now());
        self.seen.clear();
        self.committed.clear();
        vec![
            Action::Emit(Payload::TurnStarted { model: self.model.clone(), provider_session_id: self.session_id.clone() }),
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

    pub fn interrupt(&mut self) -> Vec<Action> {
        match &self.session_id {
            Some(sid) => vec![self.http("abort", "POST", &format!("/session/{sid}/abort"), Some(json!({})))],
            None => Vec::new(),
        }
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
            _ => Vec::new(),
        }
    }

    fn on_event(&mut self, kind: &str, p: &Value) -> Vec<Action> {
        let mine = |sid: &Value| self.session_id.is_none() || sid.is_null() || sid.as_str() == self.session_id.as_deref();
        match kind {
            "message.part.updated" => {
                let part = &p["part"];
                if !mine(&part["sessionID"]) {
                    return Vec::new();
                }
                self.on_part(part)
            }
            "message.part.delta" => {
                if !mine(&p["sessionID"]) {
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
            "session.idle" => {
                if !mine(&p["sessionID"]) {
                    return Vec::new();
                }
                self.end_turn(TurnStatus::Ok, None, false)
            }
            "session.status" => {
                if !mine(&p["sessionID"]) {
                    return Vec::new();
                }
                if p["status"]["type"].as_str() == Some("idle") {
                    self.end_turn(TurnStatus::Ok, None, false)
                } else {
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
                if name == "MessageAbortedError" {
                    self.end_turn(TurnStatus::Aborted, None, false)
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
                let tool = p["type"].as_str().unwrap_or("tool").to_string();
                let mut out = self.commit_open_text();
                out.push(Action::Emit(Payload::PermissionRequested {
                    request_id,
                    tool_use_id: p["callID"].as_str().unwrap_or("").into(),
                    tool_name: tool,
                    input: p["metadata"].clone(),
                    title: p["title"].as_str().map(String::from),
                    description: p["pattern"].as_str().map(|s| format!("Pattern: {s}")),
                    options: vec![
                        PermissionOption { id: "once".into(), label: "Allow once".into(), kind: PermissionOptionKind::AllowOnce },
                        PermissionOption { id: "always".into(), label: "Always allow".into(), kind: PermissionOptionKind::AllowAlways },
                        PermissionOption { id: "reject".into(), label: "Deny".into(), kind: PermissionOptionKind::Deny },
                    ],
                }));
                out
            }
            "permission.replied" => {
                let id = p["permissionID"].as_str().or_else(|| p["id"].as_str()).unwrap_or("");
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

/// Reads `/event` and hands each `data:` payload to `emit`, reconnecting
/// while `alive` says the server should still be there. Returns when the
/// server is gone.
pub fn pump_events(base: &str, alive: impl Fn() -> bool, emit: impl Fn(String)) {
    use std::io::{BufRead, BufReader};
    let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(2)).build();
    // Wait for the server to answer at all.
    let started = std::time::Instant::now();
    while alive() && started.elapsed() < std::time::Duration::from_secs(120) {
        if agent.get(&format!("{base}/session")).call().is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    if !alive() {
        return;
    }
    if started.elapsed() >= std::time::Duration::from_secs(120) {
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
pub fn perform(tag: &str, method: &str, url: &str, body: Option<Value>) -> String {
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(600)).build();
    let req = agent.request(method, url);
    let resp = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    let (status, body) = match resp {
        Ok(r) => {
            let status = r.status() as u64;
            let text = r.into_string().unwrap_or_default();
            (status, serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
        }
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            (code as u64, serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
        }
        Err(e) => (0, Value::String(e.to_string())),
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
}
