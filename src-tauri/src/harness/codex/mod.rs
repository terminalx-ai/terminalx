//! Codex: a peer. `codex app-server` speaks JSON-RPC both ways over stdio,
//! so this module is a state machine rather than a pipe: every inbound line
//! turns into a list of actions (lines to write, payloads to publish) that the
//! session manager applies. Nothing in here touches a process, which is what
//! keeps it testable against captured fixtures.
//!
//! Facts pinned by capture (codex-cli 0.152):
//! - `thread/tokenUsage/updated.tokenUsage.last` is context occupancy; `total`
//!   is cumulative over the turn and would over-report several times.
//! - The server names the approval buttons in `availableDecisions`; the reply
//!   is `{"result": {"decision": <one of them, verbatim>}}`. An empty result
//!   is treated as a refusal.
//! - `turn/interrupt` needs the turn id as well as the thread id.
//! - The prompt is echoed back as a `userMessage` item; the app records its
//!   own, so the echo is dropped.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::events::*;

pub struct SpawnPlan {
    pub program: std::path::PathBuf,
    pub args: Vec<String>,
}

pub fn spawn_plan() -> Option<SpawnPlan> {
    let program = crate::binpath::resolve("codex")?;
    Some(SpawnPlan { program, args: vec!["app-server".into()] })
}

/// Our permission modes onto Codex's two knobs.
pub fn stance(mode: &str) -> (&'static str, &'static str) {
    match mode {
        "plan" => ("untrusted", "read-only"),
        "manual" => ("untrusted", "workspace-write"),
        "bypassPermissions" => ("never", "danger-full-access"),
        _ => ("on-request", "workspace-write"),
    }
}

pub enum Action {
    Write(String),
    Emit(Payload),
    /// The thread id the server minted; the manager records it as the
    /// tab's provider session id so resume works.
    ThreadReady(String),
    /// An HTTP request for a server-backed harness; the reply comes back
    /// to the engine as a line tagged `raccoon_http`.
    Http { tag: String, method: String, url: String, body: Option<Value> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pending {
    Initialize,
    ThreadStart,
    TurnStart,
    Interrupt,
    Other,
}

#[derive(Default)]
pub struct Codex {
    next_id: u64,
    pending: HashMap<u64, Pending>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub ready: bool,
    stashed: Option<(String, Vec<(String, String)>)>,
    cwd: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: String,
    /// Open approval requests: our request id → (server request id, decisions).
    asks: HashMap<String, (u64, Vec<Value>)>,
    last_usage: Option<(u64, Option<u64>)>,
    resume_thread: Option<String>,
    turn_started_at: Option<std::time::Instant>,
}

impl Codex {
    pub fn new(cwd: &str, resume_thread: Option<String>, model: Option<String>, effort: Option<String>, mode: &str) -> Self {
        Self { cwd: cwd.into(), resume_thread, model, effort, mode: mode.into(), ..Default::default() }
    }

    fn request(&mut self, method: &str, params: Value, kind: Pending) -> String {
        self.next_id += 1;
        self.pending.insert(self.next_id, kind);
        json!({"id": self.next_id, "method": method, "params": params}).to_string()
    }

    /// The handshake, with the first prompt stashed until the thread exists.
    pub fn start(&mut self, text: String, images: Vec<(String, String)>) -> Vec<Action> {
        self.stashed = Some((text, images));
        vec![
            Action::Write(self.request("initialize", json!({"clientInfo": {"name": "raccoon", "title": "Raccoon", "version": env!("CARGO_PKG_VERSION")}}), Pending::Initialize)),
            Action::Write(json!({"method": "initialized", "params": {}}).to_string()),
        ]
    }

    fn turn_start(&mut self, text: &str, images: &[(String, String)]) -> Action {
        let thread = self.thread_id.clone().unwrap_or_default();
        let mut input: Vec<Value> = images
            .iter()
            .map(|(media, data)| json!({"type": "image", "url": format!("data:{media};base64,{data}")}))
            .collect();
        input.push(json!({"type": "text", "text": text}));
        let (approval, _) = stance(&self.mode);
        let mut params = json!({"threadId": thread, "input": input, "approvalPolicy": approval});
        if let Some(m) = self.model.as_deref().filter(|m| !m.is_empty()) {
            params["model"] = json!(m);
        }
        if let Some(e) = self.effort.as_deref().filter(|e| !e.is_empty()) {
            params["effort"] = json!(e);
        }
        self.turn_started_at = Some(std::time::Instant::now());
        Action::Write(self.request("turn/start", params, Pending::TurnStart))
    }

    /// A prompt on a live thread. Codex folds a `turn/start` on a busy thread
    /// into the running turn, so steering needs nothing extra.
    pub fn prompt(&mut self, text: String, images: Vec<(String, String)>) -> Vec<Action> {
        if self.thread_id.is_none() {
            self.stashed = Some((text, images));
            return Vec::new();
        }
        vec![self.turn_start(&text, &images)]
    }

    pub fn interrupt(&mut self) -> Vec<Action> {
        match (&self.thread_id, &self.turn_id) {
            (Some(t), Some(turn)) => {
                let params = json!({"threadId": t, "turnId": turn});
                vec![Action::Write(self.request("turn/interrupt", params, Pending::Interrupt))]
            }
            _ => Vec::new(),
        }
    }

    /// Answer an approval with one of the server's own decisions.
    pub fn answer(&mut self, request_id: &str, option_id: &str) -> Option<Vec<Action>> {
        let (server_id, decisions) = self.asks.remove(request_id)?;
        let decision = option_id
            .strip_prefix("d:")
            .and_then(|i| i.parse::<usize>().ok())
            .and_then(|i| decisions.get(i).cloned())
            .unwrap_or_else(|| json!("cancel"));
        Some(vec![Action::Write(json!({"id": server_id, "result": {"decision": decision}}).to_string())])
    }

    #[cfg(test)]
    pub fn has_ask(&self, request_id: &str) -> bool {
        self.asks.contains_key(request_id)
    }

    pub fn handle(&mut self, line: &str) -> Vec<Action> {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let has_id = v.get("id").map(|i| !i.is_null()).unwrap_or(false);
        let method = v.get("method").and_then(|m| m.as_str()).map(String::from);
        match (has_id, method) {
            (true, Some(m)) => self.on_server_request(v["id"].as_u64().unwrap_or(0), &m, &v["params"]),
            (true, None) => self.on_response(&v),
            (false, Some(m)) => self.on_notification(&m, &v["params"]),
            _ => Vec::new(),
        }
    }

    fn on_response(&mut self, v: &Value) -> Vec<Action> {
        let id = v["id"].as_u64().unwrap_or(0);
        let kind = self.pending.remove(&id).unwrap_or(Pending::Other);
        if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
            let message = err.get("message").and_then(|m| m.as_str()).unwrap_or("request failed").to_string();
            // A thread that no longer exists on this machine is not fatal: start a
            // fresh one and carry on with the stashed prompt.
            if kind == Pending::ThreadStart && self.resume_thread.take().is_some() {
                let (approval, sandbox) = stance(&self.mode);
                let mut params = json!({"cwd": self.cwd, "approvalPolicy": approval, "sandbox": sandbox});
                if let Some(m) = self.model.as_deref().filter(|m| !m.is_empty()) {
                    params["model"] = json!(m);
                }
                return vec![
                    Action::Emit(Payload::Status { text: "The previous Codex thread could not be resumed; starting a new one.".into() }),
                    Action::Write(self.request("thread/start", params, Pending::ThreadStart)),
                ];
            }
            if kind == Pending::TurnStart || kind == Pending::ThreadStart || kind == Pending::Initialize {
                return vec![Action::Emit(Payload::TurnCompleted {
                    status: TurnStatus::Error,
                    final_text: Some(message),
                    usage: None,
                    duration_ms: None,
                    head: None,
                    auth_failed: false,
                })];
            }
            return vec![Action::Emit(Payload::Error { message, fatal: false })];
        }
        let result = &v["result"];
        match kind {
            Pending::Initialize => {
                self.ready = true;
                let (approval, sandbox) = stance(&self.mode);
                let line = if let Some(t) = self.resume_thread.clone() {
                    self.request("thread/resume", json!({"threadId": t, "approvalPolicy": approval, "sandbox": sandbox}), Pending::ThreadStart)
                } else {
                    let mut params = json!({"cwd": self.cwd, "approvalPolicy": approval, "sandbox": sandbox});
                    if let Some(m) = self.model.as_deref().filter(|m| !m.is_empty()) {
                        params["model"] = json!(m);
                    }
                    self.request("thread/start", params, Pending::ThreadStart)
                };
                vec![Action::Write(line)]
            }
            Pending::ThreadStart => {
                let id = result["thread"]["id"].as_str().map(String::from);
                let mut out = Vec::new();
                if let Some(id) = id {
                    self.thread_id = Some(id.clone());
                    out.push(Action::ThreadReady(id));
                }
                if let Some((text, images)) = self.stashed.take() {
                    out.push(self.turn_start(&text, &images));
                }
                out
            }
            Pending::TurnStart => {
                if let Some(id) = result["turn"]["id"].as_str() {
                    self.turn_id = Some(id.to_string());
                }
                Vec::new()
            }
            Pending::Interrupt | Pending::Other => Vec::new(),
        }
    }

    fn on_server_request(&mut self, id: u64, method: &str, params: &Value) -> Vec<Action> {
        match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                let decisions: Vec<Value> = params["availableDecisions"].as_array().cloned().unwrap_or_else(|| vec![json!("accept"), json!("cancel")]);
                let request_id = format!("codex:{id}");
                let options = decisions
                    .iter()
                    .enumerate()
                    .map(|(i, d)| {
                        let (label, kind) = decision_label(d);
                        PermissionOption { id: format!("d:{i}"), label, kind }
                    })
                    .collect::<Vec<_>>();
                let mut options = options;
                if !options.iter().any(|o| o.kind == PermissionOptionKind::Deny) {
                    // The server can name no refusal at all; declining is always legal.
                    options.push(PermissionOption { id: "d:cancel".into(), label: "Deny".into(), kind: PermissionOptionKind::Deny });
                }
                let is_file = method.contains("fileChange");
                let tool_use_id = params["itemId"].as_str().unwrap_or("").to_string();
                let command = params["commandActions"]
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|a| a.get("command"))
                    .and_then(|c| c.as_str())
                    .or_else(|| params["command"].as_str())
                    .unwrap_or("")
                    .to_string();
                let input = if is_file { json!({"changes": params["changes"]}) } else { json!({"command": command, "cwd": params["cwd"]}) };
                self.asks.insert(request_id.clone(), (id, decisions));
                vec![Action::Emit(Payload::PermissionRequested {
                    request_id,
                    tool_use_id,
                    tool_name: if is_file { "apply_patch".into() } else { "shell".into() },
                    input,
                    title: Some(if is_file { "Edit files".into() } else { format!("shell {}", command.lines().next().unwrap_or("")) }),
                    description: params["reason"].as_str().map(String::from),
                    options,
                })]
            }
            _ => {
                // Unknown questions must still be answered or the turn hangs.
                vec![Action::Write(json!({"id": id, "error": {"code": -32601, "message": "unsupported request"}}).to_string())]
            }
        }
    }

    fn on_notification(&mut self, method: &str, p: &Value) -> Vec<Action> {
        let mut out = Vec::new();
        match method {
            "turn/started" => {
                if let Some(id) = p["turn"]["id"].as_str() {
                    self.turn_id = Some(id.into());
                }
                out.push(Action::Emit(Payload::TurnStarted { model: self.model.clone(), provider_session_id: self.thread_id.clone() }));
                out.push(Action::Emit(Payload::ModelRequestStarted));
            }
            "turn/completed" => {
                let turn = &p["turn"];
                let status = match turn["status"].as_str().unwrap_or("completed") {
                    "completed" => TurnStatus::Ok,
                    "interrupted" | "cancelled" => TurnStatus::Aborted,
                    _ => TurnStatus::Error,
                };
                let final_text = turn["error"].get("message").and_then(|m| m.as_str()).map(String::from);
                let duration_ms = turn["durationMs"].as_u64().or_else(|| self.turn_started_at.map(|t| t.elapsed().as_millis() as u64));
                self.turn_id = None;
                self.turn_started_at = None;
                let usage = self.last_usage.map(|(used, max)| Usage { context_used: Some(used), context_max: max, ..Default::default() });
                out.push(Action::Emit(Payload::TurnCompleted { status, final_text, usage, duration_ms, head: None, auth_failed: false }));
            }
            "item/started" => out.extend(self.item(&p["item"], false)),
            "item/completed" => out.extend(self.item(&p["item"], true)),
            "item/agentMessage/delta" => {
                if let (Some(id), Some(d)) = (p["itemId"].as_str(), p["delta"].as_str()) {
                    out.push(Action::Emit(Payload::Delta(Delta::TextDelta { block: block(id), text: d.into() })));
                }
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                if let (Some(id), Some(d)) = (p["itemId"].as_str(), p["delta"].as_str()) {
                    out.push(Action::Emit(Payload::Delta(Delta::ThinkingDelta { block: block(id), text: d.into() })));
                }
            }
            "thread/tokenUsage/updated" => {
                let u = &p["tokenUsage"];
                let used = u["last"]["totalTokens"].as_u64().or_else(|| u["total"]["totalTokens"].as_u64());
                let max = u["modelContextWindow"].as_u64();
                if let Some(used) = used {
                    self.last_usage = Some((used, max));
                    out.push(Action::Emit(Payload::UsageUpdate(Usage { context_used: Some(used), context_max: max, ..Default::default() })));
                }
            }
            "account/rateLimits/updated" => {
                out.push(Action::Emit(Payload::Status { text: format!("codex_rate_limit:{}", p["rateLimits"]) }));
            }
            "error" => {
                let message = p["error"]["message"].as_str().or_else(|| p["message"].as_str()).unwrap_or("Codex reported an error").to_string();
                let will_retry = p["willRetry"].as_bool().unwrap_or(false);
                if will_retry {
                    out.push(Action::Emit(Payload::ApiRetry { attempt: 1, max_retries: 1, reason: Some(message) }));
                } else {
                    out.push(Action::Emit(Payload::Error { message, fatal: false }));
                }
            }
            _ => {}
        }
        out
    }

    fn item(&mut self, item: &Value, completed: bool) -> Vec<Action> {
        let id = item["id"].as_str().unwrap_or("").to_string();
        let kind = item["type"].as_str().unwrap_or("");
        let mut out = Vec::new();
        match kind {
            "userMessage" => {}
            "agentMessage" => {
                if completed {
                    let text = item["text"].as_str().unwrap_or("").to_string();
                    out.push(Action::Emit(Payload::AssistantText { block: Some(block(&id)), text }));
                } else {
                    out.push(Action::Emit(Payload::Delta(Delta::BlockStart { block: block(&id), block_type: "text".into() })));
                }
            }
            "reasoning" => {
                if completed {
                    let mut text = String::new();
                    for part in item["summary"].as_array().into_iter().flatten().chain(item["content"].as_array().into_iter().flatten()) {
                        let t = part.as_str().or_else(|| part.get("text").and_then(|t| t.as_str())).unwrap_or("");
                        if !t.is_empty() {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                    out.push(Action::Emit(Payload::Reasoning { block: Some(block(&id)), text }));
                } else {
                    out.push(Action::Emit(Payload::Delta(Delta::BlockStart { block: block(&id), block_type: "thinking".into() })));
                }
            }
            "commandExecution" => {
                let command = item["commandActions"]
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|a| a.get("command"))
                    .and_then(|c| c.as_str())
                    .or_else(|| item["command"].as_str())
                    .unwrap_or("")
                    .to_string();
                if completed {
                    let status = item["status"].as_str().unwrap_or("completed");
                    let exit_code = item["exitCode"].as_i64().map(|c| c as i32);
                    let is_error = status == "failed" || status == "declined" || exit_code.map(|c| c != 0).unwrap_or(false);
                    let text = item["aggregatedOutput"].as_str().map(String::from).unwrap_or_else(|| if status == "declined" { "Declined".into() } else if is_error { "Command failed".into() } else { String::new() });
                    out.push(Action::Emit(Payload::ToolCallCompleted { call_id: id, result: ToolResult { text, is_error, structured: None, exit_code, images: Vec::new() } }));
                    out.push(Action::Emit(Payload::ModelRequestStarted));
                } else {
                    out.push(Action::Emit(Payload::ToolCallStarted {
                        call_id: id,
                        name: "shell".into(),
                        tool_type: ToolType::Shell,
                        input: json!({"command": command, "cwd": item["cwd"]}),
                        title: Some(format!("shell {}", command.lines().next().unwrap_or(""))),
                    }));
                }
            }
            "fileChange" => {
                if completed {
                    let status = item["status"].as_str().unwrap_or("completed");
                    out.push(Action::Emit(Payload::ToolCallCompleted {
                        call_id: id,
                        result: ToolResult { text: if status == "failed" { "Edit failed".into() } else { String::new() }, is_error: status == "failed", ..Default::default() },
                    }));
                    out.push(Action::Emit(Payload::ModelRequestStarted));
                } else {
                    let edits: Vec<FileEdit> = item["changes"]
                        .as_array()
                        .map(|cs| {
                            cs.iter()
                                .map(|c| FileEdit {
                                    path: c["path"].as_str().unwrap_or("").into(),
                                    old_text: None,
                                    new_text: None,
                                    unified: c["diff"].as_str().map(String::from),
                                    kind: match c["kind"].as_str().or_else(|| c["kind"]["type"].as_str()) {
                                        Some("add") => EditKind::Create,
                                        Some("delete") => EditKind::Delete,
                                        _ => EditKind::Update,
                                    },
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let title = match edits.as_slice() {
                        [one] => format!("apply_patch {}", one.path),
                        many => format!("apply_patch {} files", many.len()),
                    };
                    out.push(Action::Emit(Payload::ToolCallStarted { call_id: id.clone(), name: "apply_patch".into(), tool_type: ToolType::FileEdit, input: json!({"changes": item["changes"]}), title: Some(title) }));
                    out.push(Action::Emit(Payload::FileEdits { call_id: Some(id), edits }));
                }
            }
            "mcpToolCall" => {
                let name = format!("mcp__{}__{}", item["server"].as_str().unwrap_or("mcp"), item["tool"].as_str().unwrap_or("tool"));
                if completed {
                    let err = item["error"].as_object().and_then(|e| e.get("message")).and_then(|m| m.as_str());
                    let text = err.map(String::from).unwrap_or_else(|| {
                        item["result"]["content"]
                            .as_array()
                            .map(|c| c.iter().filter_map(|x| x.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"))
                            .unwrap_or_default()
                    });
                    out.push(Action::Emit(Payload::ToolCallCompleted { call_id: id, result: ToolResult { text, is_error: err.is_some(), ..Default::default() } }));
                    out.push(Action::Emit(Payload::ModelRequestStarted));
                } else {
                    let title = item["arguments"]["title"].as_str().map(|t| format!("{name} {t}")).unwrap_or_else(|| name.clone());
                    out.push(Action::Emit(Payload::ToolCallStarted { call_id: id, name, tool_type: ToolType::Mcp, input: item["arguments"].clone(), title: Some(title) }));
                }
            }
            "webSearch" => {
                let query = item["query"].as_str().unwrap_or("").to_string();
                if completed {
                    out.push(Action::Emit(Payload::ToolCallCompleted { call_id: id, result: ToolResult { text: item["action"].to_string(), ..Default::default() } }));
                } else {
                    out.push(Action::Emit(Payload::ToolCallStarted { call_id: id, name: "WebSearch".into(), tool_type: ToolType::Web, input: json!({"query": query}), title: Some(format!("WebSearch {query}")) }));
                }
            }
            "" => {}
            other => {
                if completed {
                    out.push(Action::Emit(Payload::ToolCallCompleted { call_id: id, result: ToolResult::default() }));
                } else {
                    out.push(Action::Emit(Payload::ToolCallStarted { call_id: id, name: other.into(), tool_type: ToolType::Other, input: item.clone(), title: Some(other.into()) }));
                }
            }
        }
        out
    }
}

fn block(item_id: &str) -> BlockRef {
    BlockRef { message_id: item_id.into(), index: 0 }
}

fn decision_label(d: &Value) -> (String, PermissionOptionKind) {
    match d {
        Value::String(s) => match s.as_str() {
            "accept" => ("Allow".into(), PermissionOptionKind::AllowOnce),
            "acceptForSession" => ("Allow for this session".into(), PermissionOptionKind::AllowSession),
            "decline" => ("Deny".into(), PermissionOptionKind::Deny),
            "cancel" => ("Deny and stop".into(), PermissionOptionKind::Deny),
            other => (other.to_string(), PermissionOptionKind::AllowOnce),
        },
        Value::Object(o) => {
            if o.contains_key("acceptWithExecpolicyAmendment") {
                ("Always allow this command".into(), PermissionOptionKind::AllowAlways)
            } else {
                (o.keys().next().cloned().unwrap_or_else(|| "Allow".into()), PermissionOptionKind::AllowOnce)
            }
        }
        _ => ("Allow".into(), PermissionOptionKind::AllowOnce),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = include_str!("fixtures/simple.jsonl");
    const APPROVAL: &str = include_str!("fixtures/approval.jsonl");

    /// Replay a capture: our own OUT lines are skipped, but the ids the real
    /// client used are mirrored so responses correlate.
    fn replay(text: &str) -> (Codex, Vec<Payload>, Vec<String>) {
        let mut c = Codex::new("/tmp/repo", None, None, None, "auto");
        let mut payloads = Vec::new();
        let mut writes = Vec::new();
        let acts = c.start("hi".into(), vec![]);
        for a in acts {
            if let Action::Write(w) = a {
                writes.push(w);
            }
        }
        for l in text.lines() {
            if l.starts_with("OUT ") || l.trim().is_empty() {
                continue;
            }
            for a in c.handle(l) {
                match a {
                    Action::Emit(p) => payloads.push(p),
                    Action::Write(w) => writes.push(w),
                    Action::ThreadReady(_) | Action::Http { .. } => {}
                }
            }
        }
        (c, payloads, writes)
    }

    #[test]
    fn handshake_then_thread_then_turn() {
        let (c, payloads, writes) = replay(SIMPLE);
        assert!(c.ready);
        assert!(c.thread_id.is_some());
        assert!(writes.iter().any(|w| w.contains("\"thread/start\"")));
        assert!(writes.iter().any(|w| w.contains("\"turn/start\"")));
        let kinds: Vec<&str> = payloads
            .iter()
            .filter(|p| p.is_persisted())
            .map(|p| match p {
                Payload::TurnStarted { .. } => "turn_started",
                Payload::AssistantText { .. } => "assistant_text",
                Payload::ToolCallStarted { .. } => "tool_call_started",
                Payload::ToolCallCompleted { .. } => "tool_call_completed",
                Payload::TurnCompleted { .. } => "turn_completed",
                Payload::Status { .. } => "status",
                _ => "other",
            })
            .filter(|k| *k != "status")
            .collect();
        assert_eq!(kinds, vec!["turn_started", "assistant_text", "tool_call_started", "tool_call_completed", "assistant_text", "turn_completed"]);
        let done = payloads.iter().find(|p| matches!(p, Payload::TurnCompleted { .. })).unwrap();
        if let Payload::TurnCompleted { status, usage, duration_ms, .. } = done {
            assert_eq!(*status, TurnStatus::Ok);
            assert_eq!(usage.as_ref().unwrap().context_used, Some(21210));
            assert_eq!(usage.as_ref().unwrap().context_max, Some(258400));
            assert_eq!(*duration_ms, Some(9947));
        }
        assert!(payloads.iter().any(|p| matches!(p, Payload::Delta(Delta::TextDelta { .. }))));
        // The echoed prompt is not a user message.
        assert!(!payloads.iter().any(|p| matches!(p, Payload::UserMessage { .. })));
    }

    #[test]
    fn approval_request_builds_options_from_available_decisions() {
        let (mut c, payloads, _) = replay(APPROVAL);
        let asks: Vec<_> = payloads.iter().filter(|p| matches!(p, Payload::PermissionRequested { .. })).collect();
        assert_eq!(asks.len(), 4);
        if let Payload::PermissionRequested { options, tool_name, input, request_id, .. } = asks[0] {
            assert_eq!(tool_name, "shell");
            assert!(input["command"].as_str().unwrap().starts_with("printf"));
            let kinds: Vec<_> = options.iter().map(|o| o.kind).collect();
            assert_eq!(kinds, vec![PermissionOptionKind::AllowOnce, PermissionOptionKind::AllowAlways, PermissionOptionKind::Deny]);
            assert_eq!(request_id, "codex:0");
        }
        // The last one is still open (every reply in the capture was ours).
        let last_id = if let Payload::PermissionRequested { request_id, .. } = asks[3] { request_id.clone() } else { unreachable!() };
        assert!(c.has_ask(&last_id));
        let acts = c.answer(&last_id, "d:0").unwrap();
        if let Action::Write(w) = &acts[0] {
            let v: Value = serde_json::from_str(w).unwrap();
            assert_eq!(v["result"]["decision"], "accept");
            assert_eq!(v["id"], 3);
        }
        assert!(!c.has_ask(&last_id));
        // MCP tool call drew a row.
        assert!(payloads.iter().any(|p| matches!(p, Payload::ToolCallStarted { name, .. } if name.starts_with("mcp__node_repl__"))));
    }

    #[test]
    fn interrupt_needs_a_turn() {
        let mut c = Codex::new("/tmp", None, None, None, "auto");
        assert!(c.interrupt().is_empty());
        c.thread_id = Some("t".into());
        c.turn_id = Some("u".into());
        let acts = c.interrupt();
        if let Action::Write(w) = &acts[0] {
            assert!(w.contains("turn/interrupt") && w.contains("\"turnId\":\"u\""));
        }
    }
}
