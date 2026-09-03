//! Agent Client Protocol: JSON-RPC both ways over stdio, spoken by
//! `cursor-agent acp` and any other `acp` speaker. Like the Codex module this
//! is a state machine: each inbound line becomes actions the session manager
//! applies, so the whole exchange can be replayed from fixtures.
//!
//! Facts pinned by capture (cursor-agent 2026.04.17):
//! - `initialize` answers with `authMethods`; a session cannot be opened until
//!   `authenticate` has been called with one of them, and an agent that is not
//!   logged in fails there with "Authentication required".
//! - `agentCapabilities.loadSession` gates `session/load` for resume.
//!
//! The rest follows the protocol: `session/update` notifications carry
//! message chunks, thoughts, tool calls and their updates; the agent asks for
//! permission with `session/request_permission` and for files with `fs/*`;
//! the `session/prompt` result closes the turn with a stop reason.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::events::*;
pub use crate::harness::Action;

pub struct SpawnPlan {
    pub program: std::path::PathBuf,
    pub args: Vec<String>,
}

/// The binary a harness id runs, and how it is asked to speak ACP.
pub fn spawn_plan(binary: &str) -> Option<SpawnPlan> {
    let program = crate::binpath::resolve(binary)?;
    Some(SpawnPlan { program, args: vec!["acp".into()] })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pending {
    Initialize,
    Authenticate,
    SessionNew,
    SessionLoad,
    Prompt,
    SetMode,
    SetModel,
    Other,
}

#[derive(Default)]
pub struct Acp {
    next_id: u64,
    pending: HashMap<u64, Pending>,
    pub session_id: Option<String>,
    pub ready: bool,
    stashed: Option<(String, Vec<(String, String)>)>,
    cwd: String,
    pub model: Option<String>,
    pub mode: String,
    resume: Option<String>,
    load_supported: bool,
    loading: bool,
    auth_method: Option<String>,
    /// (id, name) of the agent's own modes, from `session/new`.
    modes: Vec<(String, String)>,
    current_mode: Option<String>,
    /// Open permission requests: our request id → the agent's JSON-RPC id.
    asks: HashMap<String, u64>,
    text_buf: String,
    thought_buf: String,
    block_seq: u64,
    open_tools: HashMap<String, ToolType>,
    turn_started_at: Option<std::time::Instant>,
}

fn block(id: &str) -> BlockRef {
    BlockRef { message_id: id.into(), index: 0 }
}

fn tool_type(kind: &str) -> ToolType {
    match kind {
        "read" => ToolType::FileRead,
        "edit" => ToolType::FileEdit,
        "delete" | "move" => ToolType::FileWrite,
        "search" => ToolType::Search,
        "execute" => ToolType::Shell,
        "fetch" => ToolType::Web,
        "think" => ToolType::Plan,
        _ => ToolType::Other,
    }
}

impl Acp {
    pub fn new(cwd: &str, resume: Option<String>, model: Option<String>, mode: &str) -> Self {
        Self { cwd: cwd.into(), resume, model, mode: mode.into(), ..Default::default() }
    }

    fn request(&mut self, method: &str, params: Value, kind: Pending) -> String {
        self.next_id += 1;
        self.pending.insert(self.next_id, kind);
        json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}).to_string()
    }

    /// The handshake, with the first prompt stashed until a session exists.
    pub fn start(&mut self, text: String, images: Vec<(String, String)>) -> Vec<Action> {
        self.stashed = Some((text, images));
        let params = json!({
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": true, "writeTextFile": true}, "terminal": false},
            "clientInfo": {"name": "raccoon", "title": "TerminalX Next", "version": env!("CARGO_PKG_VERSION")},
        });
        vec![Action::Write(self.request("initialize", params, Pending::Initialize))]
    }

    fn open_session(&mut self) -> Action {
        if let (Some(id), true) = (self.resume.clone(), self.load_supported) {
            self.loading = true;
            Action::Write(self.request("session/load", json!({"sessionId": id, "cwd": self.cwd, "mcpServers": []}), Pending::SessionLoad))
        } else {
            Action::Write(self.request("session/new", json!({"cwd": self.cwd, "mcpServers": []}), Pending::SessionNew))
        }
    }

    fn prompt_line(&mut self, text: &str, images: &[(String, String)]) -> Action {
        let sid = self.session_id.clone().unwrap_or_default();
        let mut prompt = vec![json!({"type": "text", "text": text})];
        for (media, data) in images {
            prompt.push(json!({"type": "image", "mimeType": media, "data": data}));
        }
        self.turn_started_at = Some(std::time::Instant::now());
        Action::Write(self.request("session/prompt", json!({"sessionId": sid, "prompt": prompt}), Pending::Prompt))
    }

    fn begin_turn(&mut self, text: &str, images: &[(String, String)]) -> Vec<Action> {
        vec![
            Action::Emit(Payload::TurnStarted { model: self.model.clone(), provider_session_id: self.session_id.clone() }),
            Action::Emit(Payload::ModelRequestStarted),
            self.prompt_line(text, images),
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
            Some(sid) => vec![Action::Write(json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": sid}}).to_string())],
            None => Vec::new(),
        }
    }

    /// Our permission modes onto the agent's own, by name.
    fn mode_id_for(&self, mode: &str) -> Option<String> {
        let want: &[&str] = match mode {
            "plan" => &["plan"],
            "bypassPermissions" => &["yolo", "bypass", "auto", "full"],
            _ => &["agent", "default", "code", "build", "normal"],
        };
        for w in want {
            if let Some((id, _)) = self.modes.iter().find(|(id, name)| id.to_lowercase().contains(w) || name.to_lowercase().contains(w)) {
                return Some(id.clone());
            }
        }
        self.modes.iter().find(|(id, _)| !id.to_lowercase().contains("plan") && !id.to_lowercase().contains("ask")).map(|(id, _)| id.clone())
    }

    pub fn set_mode(&mut self, mode: &str) -> Vec<Action> {
        self.mode = mode.into();
        let (Some(sid), Some(id)) = (self.session_id.clone(), self.mode_id_for(mode)) else { return Vec::new() };
        if self.current_mode.as_deref() == Some(&id) {
            return Vec::new();
        }
        vec![Action::Write(self.request("session/set_mode", json!({"sessionId": sid, "modeId": id}), Pending::SetMode))]
    }

    pub fn set_model(&mut self, model: &str) -> Vec<Action> {
        self.model = Some(model.into());
        let Some(sid) = self.session_id.clone() else { return Vec::new() };
        vec![Action::Write(self.request("session/set_model", json!({"sessionId": sid, "modelId": model}), Pending::SetModel))]
    }

    /// Answer a permission request with one of the agent's own options.
    pub fn answer(&mut self, request_id: &str, option_id: &str) -> Option<Vec<Action>> {
        let id = self.asks.remove(request_id)?;
        let outcome = if option_id == "raccoon:cancel" { json!({"outcome": "cancelled"}) } else { json!({"outcome": "selected", "optionId": option_id}) };
        Some(vec![Action::Write(json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": outcome}}).to_string())])
    }

    #[cfg(test)]
    pub fn has_ask(&self, request_id: &str) -> bool {
        self.asks.contains_key(request_id)
    }

    /// Streamed text and thought become committed blocks before anything
    /// that must follow them in the transcript (a tool, an ask, the end).
    fn flush(&mut self) -> Vec<Action> {
        let mut out = Vec::new();
        if !self.thought_buf.is_empty() {
            self.block_seq += 1;
            let id = format!("acp-t{}", self.block_seq);
            out.push(Action::Emit(Payload::Reasoning { block: Some(block(&id)), text: std::mem::take(&mut self.thought_buf) }));
        }
        if !self.text_buf.is_empty() {
            self.block_seq += 1;
            let id = format!("acp-m{}", self.block_seq);
            out.push(Action::Emit(Payload::AssistantText { block: Some(block(&id)), text: std::mem::take(&mut self.text_buf) }));
        }
        out
    }

    fn stream_block(&self, kind: &str) -> BlockRef {
        block(&format!("acp-{kind}{}", self.block_seq + 1))
    }

    pub fn handle(&mut self, line: &str) -> Vec<Action> {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let has_id = v.get("id").map(|i| !i.is_null()).unwrap_or(false);
        let method = v.get("method").and_then(|m| m.as_str()).map(String::from);
        match (has_id, method) {
            (true, Some(m)) => self.on_request(&v["id"], &m, &v["params"]),
            (true, None) => self.on_response(&v),
            (false, Some(m)) => self.on_notification(&m, &v["params"]),
            _ => Vec::new(),
        }
    }

    fn fail_turn(&mut self, message: String) -> Vec<Action> {
        let auth_failed = message.to_lowercase().contains("auth") || message.to_lowercase().contains("login");
        let mut out = self.flush();
        self.turn_started_at = None;
        out.push(Action::Emit(Payload::TurnCompleted {
            status: TurnStatus::Error,
            final_text: Some(if auth_failed { format!("{message} Run `agent login` in a terminal, then try again.") } else { message }),
            usage: None,
            duration_ms: None,
            head: None,
            auth_failed,
        }));
        out
    }

    fn on_response(&mut self, v: &Value) -> Vec<Action> {
        let id = v["id"].as_u64().unwrap_or(0);
        let kind = self.pending.remove(&id).unwrap_or(Pending::Other);
        if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
            let message = err
                .pointer("/data/message")
                .and_then(|m| m.as_str())
                .or_else(|| err.get("message").and_then(|m| m.as_str()))
                .unwrap_or("request failed")
                .to_string();
            return match kind {
                Pending::SessionLoad => {
                    self.loading = false;
                    self.resume = None;
                    vec![
                        Action::Emit(Payload::Status { text: "The previous conversation could not be resumed; starting a new one.".into() }),
                        self.open_session(),
                    ]
                }
                Pending::Initialize | Pending::Authenticate | Pending::SessionNew | Pending::Prompt => self.fail_turn(message),
                Pending::SetMode | Pending::SetModel => vec![Action::Emit(Payload::Status { text: message })],
                Pending::Other => vec![Action::Emit(Payload::Error { message, fatal: false })],
            };
        }
        let result = &v["result"];
        match kind {
            Pending::Initialize => {
                self.load_supported = result.pointer("/agentCapabilities/loadSession").and_then(|b| b.as_bool()).unwrap_or(false);
                self.auth_method = result["authMethods"].as_array().and_then(|a| a.first()).and_then(|m| m["id"].as_str()).map(String::from);
                match self.auth_method.clone() {
                    Some(m) => vec![
                        Action::Emit(Payload::Status { text: "Signing in. If a browser window opened, finish the sign-in there; the agent starts once it is done.".into() }),
                        Action::Write(self.request("authenticate", json!({"methodId": m}), Pending::Authenticate)),
                    ],
                    None => vec![self.open_session()],
                }
            }
            Pending::Authenticate => vec![self.open_session()],
            Pending::SessionNew | Pending::SessionLoad => {
                self.loading = false;
                let sid = result["sessionId"].as_str().map(String::from).or_else(|| self.resume.clone());
                let mut out = Vec::new();
                if let Some(sid) = sid {
                    self.session_id = Some(sid.clone());
                    out.push(Action::ThreadReady(sid));
                }
                self.modes = result["modes"]["availableModes"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|m| Some((m["id"].as_str()?.to_string(), m["name"].as_str().unwrap_or("").to_string()))).collect())
                    .unwrap_or_default();
                self.current_mode = result["modes"]["currentModeId"].as_str().map(String::from);
                self.ready = true;
                let mode = self.mode.clone();
                out.extend(self.set_mode(&mode));
                if let Some((text, images)) = self.stashed.take() {
                    out.extend(self.begin_turn(&text, &images));
                }
                out
            }
            Pending::Prompt => {
                let mut out = self.flush();
                let status = match result["stopReason"].as_str().unwrap_or("end_turn") {
                    "cancelled" => TurnStatus::Aborted,
                    "refusal" => TurnStatus::Error,
                    _ => TurnStatus::Ok,
                };
                let duration_ms = self.turn_started_at.take().map(|t| t.elapsed().as_millis() as u64);
                out.push(Action::Emit(Payload::TurnCompleted { status, final_text: None, usage: None, duration_ms, head: None, auth_failed: false }));
                out
            }
            Pending::SetMode => {
                if let Some(id) = result["modeId"].as_str() {
                    self.current_mode = Some(id.into());
                }
                Vec::new()
            }
            Pending::SetModel | Pending::Other => Vec::new(),
        }
    }

    fn on_request(&mut self, id: &Value, method: &str, params: &Value) -> Vec<Action> {
        let reply = |result: Value| Action::Write(json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string());
        let fail = |code: i64, message: String| Action::Write(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}).to_string());
        match method {
            "session/request_permission" => {
                let rid = id.as_u64().unwrap_or(0);
                let request_id = format!("acp:{}", id);
                let mut options: Vec<PermissionOption> = params["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|o| {
                        let oid = o["optionId"].as_str()?;
                        let kind = match o["kind"].as_str().unwrap_or("") {
                            "allow_once" => PermissionOptionKind::AllowOnce,
                            "allow_always" => PermissionOptionKind::AllowAlways,
                            _ => PermissionOptionKind::Deny,
                        };
                        Some(PermissionOption { id: oid.into(), label: o["name"].as_str().unwrap_or(oid).into(), kind })
                    })
                    .collect();
                if !options.iter().any(|o| o.kind == PermissionOptionKind::Deny) {
                    options.push(PermissionOption { id: "raccoon:cancel".into(), label: "Deny".into(), kind: PermissionOptionKind::Deny });
                }
                let tc = &params["toolCall"];
                let kind = tc["kind"].as_str().unwrap_or("other");
                let tool_use_id = tc["toolCallId"].as_str().unwrap_or("").to_string();
                let input = if tc["rawInput"].is_null() { json!({"locations": tc["locations"]}) } else { tc["rawInput"].clone() };
                self.asks.insert(request_id.clone(), rid);
                let mut out = self.flush();
                out.push(Action::Emit(Payload::PermissionRequested {
                    request_id,
                    tool_use_id,
                    tool_name: kind.into(),
                    input,
                    title: tc["title"].as_str().map(String::from),
                    description: None,
                    options,
                }));
                out
            }
            "fs/read_text_file" => {
                let path = params["path"].as_str().unwrap_or("");
                match std::fs::read_to_string(path) {
                    Ok(text) => {
                        let start = params["line"].as_u64().map(|l| l.saturating_sub(1) as usize).unwrap_or(0);
                        let limit = params["limit"].as_u64().map(|l| l as usize);
                        let content: String = match limit {
                            Some(n) => text.lines().skip(start).take(n).collect::<Vec<_>>().join("\n"),
                            None if start > 0 => text.lines().skip(start).collect::<Vec<_>>().join("\n"),
                            None => text,
                        };
                        vec![reply(json!({"content": content}))]
                    }
                    Err(e) => vec![fail(-32000, format!("{path}: {e}"))],
                }
            }
            "fs/write_text_file" => {
                let path = params["path"].as_str().unwrap_or("");
                let content = params["content"].as_str().unwrap_or("");
                let done = std::path::Path::new(path).parent().map(|p| std::fs::create_dir_all(p).is_ok()).unwrap_or(true) && std::fs::write(path, content).is_ok();
                if done {
                    vec![reply(Value::Null)]
                } else {
                    vec![fail(-32000, format!("could not write {path}"))]
                }
            }
            _ => vec![fail(-32601, "unsupported request".into())],
        }
    }

    fn on_notification(&mut self, method: &str, p: &Value) -> Vec<Action> {
        if method != "session/update" || self.loading {
            return Vec::new();
        }
        let u = &p["update"];
        let mut out = Vec::new();
        match u["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                if let Some(t) = u["content"]["text"].as_str() {
                    let b = self.stream_block("m");
                    self.text_buf.push_str(t);
                    out.push(Action::Emit(Payload::Delta(Delta::TextDelta { block: b, text: t.into() })));
                }
            }
            "agent_thought_chunk" => {
                if let Some(t) = u["content"]["text"].as_str() {
                    let b = self.stream_block("t");
                    self.thought_buf.push_str(t);
                    out.push(Action::Emit(Payload::Delta(Delta::ThinkingDelta { block: b, text: t.into() })));
                }
            }
            "tool_call" => {
                out.extend(self.flush());
                let id = u["toolCallId"].as_str().unwrap_or("").to_string();
                let kind = u["kind"].as_str().unwrap_or("other");
                let tt = tool_type(kind);
                let title = u["title"].as_str().map(String::from);
                let input = if u["rawInput"].is_null() { json!({"locations": u["locations"]}) } else { u["rawInput"].clone() };
                self.open_tools.insert(id.clone(), tt);
                out.push(Action::Emit(Payload::ToolCallStarted { call_id: id.clone(), name: kind.into(), tool_type: tt, input, title }));
                let status = u["status"].as_str().unwrap_or("pending");
                if status == "completed" || status == "failed" {
                    out.extend(self.finish_tool(&id, u));
                }
            }
            "tool_call_update" => {
                let id = u["toolCallId"].as_str().unwrap_or("").to_string();
                let status = u["status"].as_str().unwrap_or("in_progress");
                if (status == "completed" || status == "failed") && self.open_tools.contains_key(&id) {
                    out.extend(self.finish_tool(&id, u));
                }
            }
            "current_mode_update" => {
                self.current_mode = u["currentModeId"].as_str().map(String::from);
            }
            _ => {}
        }
        out
    }

    fn finish_tool(&mut self, id: &str, u: &Value) -> Vec<Action> {
        self.open_tools.remove(id);
        let failed = u["status"].as_str() == Some("failed");
        let mut text = String::new();
        let mut edits = Vec::new();
        for c in u["content"].as_array().into_iter().flatten() {
            match c["type"].as_str().unwrap_or("") {
                "content" => {
                    if let Some(t) = c["content"]["text"].as_str() {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
                "diff" => edits.push(FileEdit {
                    path: c["path"].as_str().unwrap_or("").into(),
                    old_text: c["oldText"].as_str().map(String::from),
                    new_text: c["newText"].as_str().map(String::from),
                    unified: None,
                    kind: EditKind::default(),
                }),
                _ => {}
            }
        }
        if text.is_empty() {
            if let Some(raw) = u.get("rawOutput").filter(|r| !r.is_null()) {
                text = raw.as_str().map(String::from).unwrap_or_else(|| raw.to_string());
            }
        }
        let mut out = Vec::new();
        if !edits.is_empty() {
            out.push(Action::Emit(Payload::FileEdits { call_id: Some(id.into()), edits }));
        }
        out.push(Action::Emit(Payload::ToolCallCompleted { call_id: id.into(), result: ToolResult { text, is_error: failed, ..Default::default() } }));
        out.push(Action::Emit(Payload::ModelRequestStarted));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn writes(actions: &[Action]) -> Vec<Value> {
        actions.iter().filter_map(|a| if let Action::Write(l) = a { serde_json::from_str(l).ok() } else { None }).collect()
    }
    fn emits(actions: &[Action]) -> Vec<&Payload> {
        actions.iter().filter_map(|a| if let Action::Emit(p) = a { Some(p) } else { None }).collect()
    }

    #[test]
    fn handshake_authenticates_then_opens_and_prompts() {
        let mut a = Acp::new("/tmp/x", None, Some("sonnet-4".into()), "auto");
        let w = writes(&a.start("hello".into(), vec![]));
        assert_eq!(w[0]["method"], "initialize");
        let acts = a.handle(r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"cursor_login","name":"Cursor Login"}]}}"#);
        assert_eq!(writes(&acts)[0]["method"], "authenticate");
        let acts = a.handle(r#"{"jsonrpc":"2.0","id":2,"result":null}"#);
        assert_eq!(writes(&acts)[0]["method"], "session/new");
        let acts = a.handle(r#"{"jsonrpc":"2.0","id":3,"result":{"sessionId":"s1","modes":{"currentModeId":"agent","availableModes":[{"id":"agent","name":"Agent"},{"id":"plan","name":"Plan"}]}}}"#);
        assert!(matches!(acts[0], Action::ThreadReady(ref s) if s == "s1"));
        let w = writes(&acts);
        let prompt = w.iter().find(|x| x["method"] == "session/prompt").expect("prompt sent");
        assert_eq!(prompt["params"]["prompt"][0]["text"], "hello");
        assert!(emits(&acts).iter().any(|p| matches!(p, Payload::TurnStarted { .. })));
    }

    #[test]
    fn not_logged_in_fails_the_turn_with_a_hint() {
        let mut a = Acp::new("/tmp/x", None, None, "auto");
        a.start("hi".into(), vec![]);
        a.handle(r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[{"id":"cursor_login"}]}}"#);
        let acts = a.handle(r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required","data":{"message":"Authentication required. Please run 'agent login' first."}}}"#);
        match emits(&acts)[0] {
            Payload::TurnCompleted { status, auth_failed, final_text, .. } => {
                assert_eq!(*status, TurnStatus::Error);
                assert!(auth_failed);
                assert!(final_text.as_deref().unwrap().contains("agent login"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn updates_become_stream_then_committed_blocks_and_tools() {
        let mut a = Acp::new("/tmp/x", None, None, "auto");
        a.start("do it".into(), vec![]);
        a.handle(r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}}"#);
        a.handle(r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}"#);
        let acts = a.handle(r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Let me "}}}}"#);
        assert!(matches!(emits(&acts)[0], Payload::Delta(Delta::TextDelta { .. })));
        let acts = a.handle(r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Write hello.txt","kind":"edit","status":"pending","rawInput":{"path":"hello.txt"}}}}"#);
        let e = emits(&acts);
        assert!(matches!(e[0], Payload::AssistantText { text, .. } if text == "Let me "));
        assert!(matches!(e[1], Payload::ToolCallStarted { tool_type: ToolType::FileEdit, .. }));
        let acts = a.handle(r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed","content":[{"type":"diff","path":"/tmp/x/hello.txt","oldText":"","newText":"hi\n"}]}}}"#);
        let e = emits(&acts);
        assert!(matches!(e[0], Payload::FileEdits { edits, .. } if edits.len() == 1));
        assert!(matches!(e[1], Payload::ToolCallCompleted { result, .. } if !result.is_error));
        let acts = a.handle(r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#);
        assert!(emits(&acts).iter().any(|p| matches!(p, Payload::TurnCompleted { status: TurnStatus::Ok, .. })));
    }

    #[test]
    fn permission_round_trip_uses_the_agents_option_ids() {
        let mut a = Acp::new("/tmp/x", None, None, "auto");
        a.start("x".into(), vec![]);
        a.handle(r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}}"#);
        a.handle(r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}"#);
        let acts = a.handle(r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"c2","title":"rm -rf build","kind":"execute","rawInput":{"command":"rm -rf build"}},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}"#);
        let e = emits(&acts);
        let Payload::PermissionRequested { request_id, options, .. } = e[0] else { panic!() };
        assert_eq!(options.len(), 2);
        assert!(a.has_ask(request_id));
        let reply = writes(&a.answer(request_id, "allow").unwrap());
        assert_eq!(reply[0]["id"], 9);
        assert_eq!(reply[0]["result"]["outcome"]["optionId"], "allow");
        assert!(!a.has_ask(request_id));
    }

    #[test]
    fn fs_requests_are_served() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let mut a = Acp::new(dir.path().to_str().unwrap(), None, None, "auto");
        let req = json!({"jsonrpc":"2.0","id":4,"method":"fs/read_text_file","params":{"sessionId":"s","path":path,"line":2,"limit":1}}).to_string();
        let reply = writes(&a.handle(&req));
        assert_eq!(reply[0]["result"]["content"], "two");
        let out = dir.path().join("sub/b.txt");
        let req = json!({"jsonrpc":"2.0","id":5,"method":"fs/write_text_file","params":{"sessionId":"s","path":out,"content":"hi"}}).to_string();
        let reply = writes(&a.handle(&req));
        assert!(reply[0].get("result").is_some());
        assert_eq!(std::fs::read_to_string(out).unwrap(), "hi");
    }
}
