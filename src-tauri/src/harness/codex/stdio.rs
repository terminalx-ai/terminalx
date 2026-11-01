//! Explicitly experimental, single-owner stdio protocol. No process or store I/O.
//! Contracts/emitter ordering were verified on Codex 0.164.0; later releases
//! only add optional fields to the stable v2 surface used here (checked through
//! 0.166.0). The session manager fences every action by the exact child launch
//! and is the only final writer.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};

use crate::events::*;
use super::owned_transport::{self, Observation};

pub const MIN_VERSION: &str = "0.164.0";
const MAX_PENDING: usize = 32;
const MAX_ASKS: usize = 64;

#[derive(Debug)]
pub(crate) enum Action {
    Write(Outbound),
    ThreadReady(String),
    Emit(Payload),
    Lifecycle(Observation),
    /// A manual compact command ends without becoming a user/model turn.
    CompactEnded,
}

/// A queued frame retains the authority that produced it until the last byte.
#[derive(Debug)]
pub(crate) struct Outbound {
    pub line: String,
    validity: WriteValidity,
}
#[derive(Debug)]
enum WriteValidity { Connection, Request { id: u64, discard_if_stale: bool, prompt: bool }, Reply(String) }
impl Outbound {
    pub(crate) fn connection(line: String) -> Self { Self { line, validity: WriteValidity::Connection } }
    /// The frame that hands Codex a prompt: a turn or a manual compaction.
    /// Its sender's authority is checked before its first byte is written.
    pub(crate) fn delivers_prompt(&self) -> bool { matches!(self.validity, WriteValidity::Request { prompt: true, .. }) }
    pub(crate) fn can_discard_unsent(&self) -> bool {
        matches!(self.validity, WriteValidity::Reply(_) | WriteValidity::Request { discard_if_stale: true, .. })
    }
}
struct Pending { kind: Request, epoch: u64, turn: Option<String> }

#[derive(Clone, Copy)]
enum Request { Initialize, Thread, Turn, Compact, Interrupt }

struct Ask { id: Value, turn: String, method: String }

pub struct Stdio {
    pub launch: Arc<()>,
    pub thread: Option<String>,
    pub exited: bool,
    pub blocked: bool,
    pub ready: bool,
    pub lifecycle_lost: bool,
    turn: Option<String>,
    manual_compact: bool,
    next_id: u64,
    pending: HashMap<u64, Pending>,
    turn_epoch: u64,
    answers: HashMap<String, Ask>,
    asks: HashMap<String, Ask>,
    seen_text: HashSet<String>,
    cwd: String,
    model: String,
    effort: Option<String>,
    mode: String,
    /// Only the initial, explicitly submitted local input. Never replayed.
    first: Option<(String, Vec<(String, String)>)>,
    /// The tab's earlier thread, continued with `thread/resume` instead of a
    /// new `thread/start`. Its turns are not requested back.
    resume: Option<String>,
}

/// Whether `codex --version` reports MIN_VERSION or a later release.
pub(crate) fn supported(version: &str) -> bool {
    let release = |text: &str| -> Option<(u64, u64, u64)> {
        let mut parts = text.split(|c: char| !c.is_ascii_digit()).filter(|part| !part.is_empty()).map(str::parse);
        Some((parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?))
    };
    let Some(found) = version.trim().strip_prefix("codex-cli ").and_then(release) else { return false };
    release(MIN_VERSION).is_some_and(|min| found >= min)
}

impl Stdio {
    pub(crate) fn validate_mode(mode: &str) -> Result<()> {
        ensure!(matches!(mode, "plan" | "auto" | "acceptEdits" | "bypassPermissions" | ""),
            "Experimental Codex stdio does not support Ask every time. Choose plan, auto, or bypass for a new experimental session.");
        Ok(())
    }

    pub(crate) fn new(cwd: String, model: String, effort: Option<String>, mode: String, resume: Option<String>) -> Self {
        Self { launch: Arc::new(()), thread: None, exited: false, blocked: false, ready: false, lifecycle_lost: false,
            turn: None, manual_compact: false, next_id: 0, pending: HashMap::new(), asks: HashMap::new(), turn_epoch: 0, answers: HashMap::new(),
            seen_text: HashSet::new(), cwd, model, effort, mode, first: None, resume }
    }

    /// A new model or effort reaches Codex with the next turn it starts;
    /// `turn/start` takes both for that turn and the ones after it.
    pub(crate) fn set_model(&mut self, model: &str) { self.model = model.to_owned(); }
    pub(crate) fn set_effort(&mut self, effort: Option<&str>) { self.effort = effort.map(str::to_owned); }

    fn request(&mut self, method: &str, params: Value, kind: Request) -> Result<Action> {
        ensure!(!self.exited && !self.blocked, "Experimental Codex connection is no longer writable");
        ensure!(self.pending.len() < MAX_PENDING, "Too many pending Codex requests");
        self.next_id = self.next_id.checked_add(1).ok_or_else(|| anyhow::anyhow!("request IDs exhausted"))?;
        self.pending.insert(self.next_id, Pending { kind, epoch: self.turn_epoch, turn: self.turn.clone() });
        Ok(Action::Write(Outbound { line: json!({"id": self.next_id, "method": method, "params": params}).to_string(), validity: WriteValidity::Request { id: self.next_id, discard_if_stale: matches!(kind, Request::Interrupt), prompt: matches!(kind, Request::Turn | Request::Compact) } }))
    }

    pub(crate) fn start(&mut self, text: String, images: Vec<(String, String)>) -> Result<Vec<Action>> {
        ensure!(self.next_id == 0, "Codex handshake already started");
        self.manual_compact = text.trim() == "/compact";
        self.first = Some((text, images));
        Ok(vec![self.request("initialize", json!({"clientInfo": {"name": "terminalx_experimental", "title": "TerminalX experimental stdio", "version": env!("CARGO_PKG_VERSION")}, "capabilities": {"experimentalApi": false}}), Request::Initialize)?])
    }

    pub(crate) fn prompt(&mut self, text: String, images: Vec<(String, String)>) -> Result<Vec<Action>> {
        ensure!(self.ready && self.turn.is_none(), "Codex is not ready for another prompt");
        let thread = self.thread.clone().ok_or_else(|| anyhow::anyhow!("missing Codex thread"))?;
        if text.trim() == "/compact" {
            ensure!(images.is_empty(), "Compaction does not accept images");
            self.manual_compact = true;
            return Ok(vec![self.request("thread/compact/start", json!({"threadId": thread}), Request::Compact)?]);
        }
        ensure!(!text.trim_start().starts_with('/'), "Only /compact is supported in experimental Codex stdio");
        self.manual_compact = false;
        let mut input = vec![json!({"type": "text", "text": text})];
        input.extend(images.into_iter().map(|(mime, data)| json!({"type": "image", "url": format!("data:{mime};base64,{data}")})));
        let model = if self.model.is_empty() { None } else { Some(&self.model) };
        Ok(vec![self.request("turn/start", json!({"threadId": thread, "input": input, "model": model, "effort": self.effort}), Request::Turn)?])
    }

    pub(crate) fn interrupt(&mut self) -> Result<Vec<Action>> {
        // Before thread/turn acceptance there is no safe interrupt target. Fence
        // the deferred input instead of letting a late handshake send it.
        if self.turn.is_none() {
            self.first = None;
            self.blocked = true;
            bail!("Codex has not reported a turn to interrupt. Stop this experimental session.");
        }
        Ok(vec![self.request("turn/interrupt", json!({"threadId": self.thread, "turnId": self.turn}), Request::Interrupt)?])
    }

    pub(crate) fn answer(&mut self, request: &str, option: &str) -> Result<Vec<Action>> {
        ensure!(!self.exited && !self.blocked, "Codex permission request has expired");
        ensure!(matches!(option, "allow" | "deny"), "Unknown Codex permission decision");
        let ask = self.asks.get(request).ok_or_else(|| anyhow::anyhow!("Codex permission request has expired"))?;
        ensure!(Some(&ask.turn) == self.turn.as_ref(), "Codex permission belongs to an earlier turn");
        let result = match ask.method.as_str() {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => json!({"decision": if option == "allow" { "accept" } else { "decline" }}),
            _ => bail!("Unsupported Codex permission request"),
        };
        let ask = self.asks.remove(request).unwrap();
        let line = json!({"id": ask.id, "result": result}).to_string();
        self.answers.insert(request.to_owned(), ask);
        Ok(vec![Action::Write(Outbound { line, validity: WriteValidity::Reply(request.to_owned()) })])
    }

    pub(crate) fn cancel_asks(&mut self) -> Vec<Action> {
        self.asks.drain().map(|(key, ask)| {
            let line = json!({"id": ask.id, "result": {"decision": "cancel"}}).to_string();
            self.answers.insert(key.clone(), ask);
            Action::Write(Outbound { line, validity: WriteValidity::Reply(key) })
        }).collect()
    }

    pub(crate) fn write_is_current(&self, frame: &Outbound) -> bool {
        if self.exited || self.blocked { return false; }
        match &frame.validity {
            WriteValidity::Connection => true,
            WriteValidity::Reply(key) => self.answers.get(key).is_some_and(|ask| Some(&ask.turn) == self.turn.as_ref()),
            WriteValidity::Request { id, .. } => self.pending.get(id).is_some_and(|pending| match pending.kind {
                Request::Initialize | Request::Thread => true,
                Request::Turn | Request::Compact => pending.epoch == self.turn_epoch && self.turn.is_none(),
                Request::Interrupt => pending.epoch == self.turn_epoch && pending.turn == self.turn && self.turn.is_some(),
            }),
        }
    }

    /// Retire an entirely unsent stale frame or a fully delivered reply. Never
    /// remove a live request on delivery: its response still needs correlation.
    pub(crate) fn retire_write(&mut self, frame: &Outbound, sent: bool) {
        match &frame.validity {
            WriteValidity::Request { id, .. } if !sent => { self.pending.remove(id); }
            WriteValidity::Reply(key) => { self.answers.remove(key); }
            _ => {},
        }
    }

    /// A prompt its sender may no longer give: nothing of it was written, so
    /// its request is forgotten and the connection stays ready for the next.
    pub(crate) fn withdraw(&mut self, frame: &Outbound) {
        self.retire_write(frame, false);
        if frame.delivers_prompt() { self.manual_compact = false; }
    }

    pub(crate) fn is_manual_compact(&self) -> bool { self.manual_compact || self.first.as_ref().is_some_and(|(text, _)| text.trim() == "/compact") }

    pub(crate) fn fail(&mut self) {
        self.blocked = true;
        self.first = None;
        self.pending.clear();
        self.asks.clear();
        self.answers.clear();
    }

    pub(crate) fn handle(&mut self, line: &str) -> Result<Vec<Action>> {
        ensure!(line.len() <= 16 * 1024 * 1024, "Codex protocol frame exceeds limit");
        let v: Value = serde_json::from_str(line)?;
        if self.blocked || self.exited {
            // Closing input authority does not discard positive lifecycle
            // evidence buffered before the owned reader reached EOF. Ignore
            // other late frames, including approval requests, without turning
            // them into a protocol failure that masks a later completion.
            return Ok(self.thread.as_deref().and_then(|thread| owned_transport::decode(line, thread))
                .filter(|observation| matches!(observation, Observation::ItemCompleted { .. }))
                .map(Action::Lifecycle).into_iter().collect());
        }
        if let Some(id) = v.get("id") {
            if v.get("method").is_some() {
                return self.server_request(&v, id);
            }
            let Some(pending) = id.as_u64().and_then(|id| self.pending.remove(&id)) else { return Ok(Vec::new()); };
            if self.exited { return Ok(Vec::new()); }
            if let Some(error) = v.get("error") { bail!("Codex request failed: {}", error["message"].as_str().unwrap_or("unknown protocol error")); }
            let result = v.get("result").ok_or_else(|| anyhow::anyhow!("Codex response has no result"))?;
            return match pending.kind {
                Request::Initialize => {
                    let (approval, sandbox) = super::stance(&self.mode);
                    let approval = if approval == super::pty::BYPASS { "never" } else { approval };
                    let mut params = json!({"cwd": self.cwd, "model": if self.model.is_empty() { None } else { Some(&self.model) }, "approvalPolicy": approval, "sandbox": sandbox});
                    let method = match &self.resume {
                        Some(thread) => {
                            params["threadId"] = json!(thread);
                            params["excludeTurns"] = json!(true);
                            "thread/resume"
                        }
                        None => "thread/start",
                    };
                    Ok(vec![Action::Write(Outbound::connection(json!({"method":"initialized"}).to_string())),
                        self.request(method, params, Request::Thread)?])
                }
                Request::Thread => {
                    let id = required(&result["thread"], "id")?;
                    ensure!(self.thread.is_none(), "Codex changed thread during initialization");
                    ensure!(self.resume.as_ref().is_none_or(|thread| *thread == id), "Codex resumed a different thread");
                    self.thread = Some(id.clone());
                    self.ready = true;
                    let mut actions = vec![Action::ThreadReady(id)];
                    if let Some((text, images)) = self.first.take() { actions.extend(self.prompt(text, images)?); }
                    Ok(actions)
                }
                Request::Turn => {
                    let id = required(&result["turn"], "id")?;
                    // The notification owns turn lifetime; a delayed response
                    // must not reopen a turn that already completed.
                    let _ = id;
                    Ok(Vec::new())
                }
                Request::Compact | Request::Interrupt => Ok(Vec::new()),
            };
        }
        let method = required(&v, "method")?;
        let p = &v["params"];
        if p["threadId"].as_str() != self.thread.as_deref() || self.thread.is_none() { return Ok(Vec::new()); }
        let mut out = Vec::new();
        if let Some(observation) = owned_transport::decode(line, self.thread.as_deref().unwrap()) {
            out.push(Action::Lifecycle(observation));
        }
        match method.as_str() {
            "turn/started" => {
                self.turn_epoch = self.turn_epoch.checked_add(1).ok_or_else(|| anyhow::anyhow!("turn epochs exhausted"))?;
                self.turn = Some(required(&p["turn"], "id")?);
                self.seen_text.clear();
                if !self.manual_compact {
                    out.push(Action::Emit(Payload::TurnStarted { model: None, provider_session_id: self.thread.clone(), prompt_seq: None, started_by: None, initiating_prompt: None }));
                }
            }
            "turn/completed" => {
                let id = required(&p["turn"], "id")?;
                if self.turn.as_deref() != Some(&id) { return Ok(out); }
                self.turn = None;
                self.turn_epoch = self.turn_epoch.checked_add(1).ok_or_else(|| anyhow::anyhow!("turn epochs exhausted"))?;
                self.answers.clear();
                // Terminal notifications outrank a delayed RPC error for that
                // turn. In particular an already-sent interrupt may race its
                // natural completion; its stale error cannot fail the next turn.
                self.pending.retain(|_, pending| matches!(pending.kind, Request::Initialize | Request::Thread));
                for (request_id, _) in self.asks.drain() {
                    out.push(Action::Emit(Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }));
                }
                if self.manual_compact {
                    self.manual_compact = false;
                    out.push(Action::CompactEnded);
                } else {
                    let status = match p["turn"]["status"].as_str() {
                        Some("completed") => TurnStatus::Ok,
                        Some("failed") => TurnStatus::Error,
                        Some("interrupted") => TurnStatus::Aborted,
                        _ => bail!("Unknown Codex terminal turn status"),
                    };
                    let error = &p["turn"]["error"];
                    // A turn's error is about its model request, so a 401
                    // there is Codex's own sign-in being refused (#667).
                    let auth_failed = status == TurnStatus::Error
                        && (error["codexErrorInfo"] == "unauthorized"
                            || error["codexErrorInfo"].as_object().is_some_and(|info| info.values().any(|detail| detail["httpStatusCode"] == 401))
                            || error["message"].as_str().is_some_and(crate::recovery::sign_in_refused));
                    out.push(Action::Emit(Payload::TurnCompleted { status, final_text: error["message"].as_str().map(str::to_owned), usage: None, duration_ms: None, head: None, auth_failed, detail: None }));
                }
            }
            "item/agentMessage/delta" => {
                let id = required(p, "itemId")?;
                self.seen_text.insert(id.clone());
                out.push(Action::Emit(Payload::AssistantText { block: Some(block(&id)), text: required(p, "delta")? }));
            }
            "item/reasoning/summaryTextDelta" => out.push(Action::Emit(Payload::Reasoning { block: Some(block(&required(p, "itemId")?)), text: required(p, "delta")? })),
            "item/started" | "item/completed" => {
                let item = &p["item"];
                let id = required(item, "id")?;
                let completed = method == "item/completed";
                match item["type"].as_str() {
                    // The lifecycle channel above is the sole compaction source.
                    Some("contextCompaction" | "userMessage") => {},
                    Some("agentMessage") if completed && !self.seen_text.contains(&id) => out.push(Action::Emit(Payload::AssistantText { block: Some(block(&id)), text: required(item, "text")? })),
                    Some(kind @ ("commandExecution" | "fileChange" | "mcpToolCall" | "webSearch")) => {
                        if completed {
                            out.push(Action::Emit(Payload::ToolCallCompleted { call_id: id, result: ToolResult { text: item["aggregatedOutput"].as_str().unwrap_or("").to_owned(), is_error: matches!(item["status"].as_str(), Some("failed" | "declined")), exit_code: item["exitCode"].as_i64().and_then(|n| i32::try_from(n).ok()), structured: Some(item.clone()), ..Default::default() } }));
                        } else {
                            out.push(Action::Emit(Payload::ToolCallStarted { call_id: id, name: kind.into(), tool_type: match kind { "commandExecution" => ToolType::Shell, "fileChange" => ToolType::FileEdit, "webSearch" => ToolType::Web, _ => ToolType::Mcp }, input: item.clone(), title: None }));
                        }
                    }
                    _ => {},
                }
            }
            "thread/tokenUsage/updated" => {
                let usage = &p["tokenUsage"];
                out.push(Action::Emit(Payload::UsageUpdate(Usage { input_tokens: usage["total"]["inputTokens"].as_u64(), output_tokens: usage["total"]["outputTokens"].as_u64(), context_used: usage["last"]["totalTokens"].as_u64(), context_max: usage["modelContextWindow"].as_u64(), ..Default::default() })));
            }
            "serverRequest/resolved" => {
                let key = p["requestId"].to_string();
                self.answers.remove(&key);
                if self.asks.remove(&key).is_some() { out.push(Action::Emit(Payload::PermissionDecided { request_id: key, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true })); }
            }
            "error" if p["willRetry"].as_bool() == Some(true) => out.push(Action::Emit(Payload::Status { text: "Codex is retrying its request".into() })),
            "error" => out.push(Action::Emit(Payload::Error { message: p["error"]["message"].as_str().unwrap_or("Codex reported an error").to_owned(), fatal: false, detail: None })),
            _ => {},
        }
        Ok(out)
    }

    fn server_request(&mut self, v: &Value, id: &Value) -> Result<Vec<Action>> {
        ensure!(!self.exited, "Codex exited before its request was handled");
        let method = required(v, "method")?;
        let p = &v["params"];
        ensure!(p["threadId"].as_str() == self.thread.as_deref() && self.thread.is_some(), "Codex request belongs to another thread");
        let turn = required(p, "turnId")?;
        ensure!(Some(&turn) == self.turn.as_ref(), "Codex request belongs to another turn");
        ensure!(id.is_string() || id.is_i64() || id.is_u64(), "Invalid Codex request ID");
        let key = id.to_string();
        ensure!(self.asks.len() + self.answers.len() < MAX_ASKS && !self.asks.contains_key(&key) && !self.answers.contains_key(&key), "Duplicate or excessive Codex approval requests");
        if !matches!(method.as_str(), "item/commandExecution/requestApproval" | "item/fileChange/requestApproval") {
            // Fail closed for protocol extensions; never synthesize consent.
            self.answers.insert(key.clone(), Ask { id: id.clone(), turn, method: method.clone() });
            return Ok(vec![Action::Write(Outbound { line: json!({"id":id,"error":{"code":-32601,"message":"This request is not supported by TerminalX experimental stdio"}}).to_string(), validity: WriteValidity::Reply(key) }), Action::Emit(Payload::Error { message: format!("Experimental Codex stdio cannot handle {method}. No approval was granted."), fatal: false, detail: None })]);
        }
        if let Some(decisions) = p.get("availableDecisions").and_then(Value::as_array) {
            ensure!(decisions.iter().any(|d| d == "accept") && decisions.iter().any(|d| d == "decline"), "Codex offers approval choices this experimental client cannot represent");
        }
        self.asks.insert(key.clone(), Ask { id: id.clone(), turn, method: method.clone() });
        Ok(vec![Action::Emit(Payload::PermissionRequested { request_id: key, tool_use_id: required(p, "itemId")?, tool_name: method, input: p.clone(), cwd: p["cwd"].as_str().map(str::to_owned), title: Some("Codex requests approval".into()), description: p["reason"].as_str().map(str::to_owned), options: vec![PermissionOption { id: "allow".into(), label: "Allow once".into(), kind: PermissionOptionKind::AllowOnce }, PermissionOption { id: "deny".into(), label: "Deny".into(), kind: PermissionOptionKind::Deny }] })])
    }
}

fn required(value: &Value, key: &str) -> Result<String> {
    value[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(|| anyhow::anyhow!("Codex frame missing {key}"))
}
fn block(id: &str) -> BlockRef { BlockRef { message_id: id.into(), index: 0 } }

#[cfg(test)]
#[path = "stdio_tests.rs"]
mod tests;
