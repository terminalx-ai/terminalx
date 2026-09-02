//! The session manager: one runtime per tab, driving a harness child through
//! the host, numbering and persisting events, and answering the frontend.
//!
//! Status follows the turn alone: send → in_progress, `turn_completed` →
//! completed (meaning finished and unread), child exit → idle. A pending
//! permission or question marks the tab waiting until it is answered.
//!
//! Claude Code is PTY-first: the tab *is* the interactive CLI, running in a
//! terminal pane. Nothing is parsed off the wire — what was said comes from
//! the CLI's transcript file, what is happening comes from its hooks, and what
//! the reader types goes back in as keystrokes.
//!
//! The other harnesses are still headless children: Codex is a peer (a state
//! machine answering each line with actions), ACP and OpenCode likewise. The
//! manager owns the parts they share — the child, the seq counter, the log,
//! the queue.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::events::*;
use crate::harness::host::{Host, LiveChild, Sink, SpawnSpec};
use crate::harness::{acp, claude, codex, opencode, tui, Action, CliKind, HarnessId};
use crate::hooks::{HookFrame, HookReply};
use crate::store::index::{self, TabEntry, TabStatus};
use crate::{git, pty, store};

pub struct PendingAsk {
    pub tool_use_id: String,
    pub input: Value,
    /// Suggestion payloads keyed by option id ("suggest:N").
    pub suggestions: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<(String, String)>,
}

/// What the reader chose, in terms every CLI's hooks can express. The hook
/// thread that parked turns it into that CLI's own reply shape.
#[derive(Debug, Clone)]
pub enum Decision {
    Allow,
    /// Allow, and take one of the CLI's own permission suggestions with it.
    AllowWith(Value),
    /// Allow, carrying the answers to a question back as the tool's input.
    Answers(Value),
    Deny,
}

/// What a PTY-first tab needs to start: the line the pane runs, the
/// transcript to follow, and the conversation id if the app minted one.
struct CliLaunch {
    command: String,
    tail: tui::Tail,
    minted: Option<String>,
}

/// A PTY-first tab: the CLI in a pane, its transcript being followed, and the
/// permission frames its hooks have parked here waiting for an answer.
pub struct CliTab {
    /// Which CLI is in the pane. The launch line, the hook plumbing and the
    /// transcript differ per harness; nothing below does.
    pub harness: CliKind,
    /// The permission mode it was started with. A Codex tab reads it on every
    /// tool hook to know whether the reader wants to be asked about that tool.
    pub mode: String,
    pub pane_id: String,
    /// Which start this is. A pane restarted in place keeps its id, so the
    /// generation is what tells the previous tailer that it is finished.
    pub generation: u64,
    pub tail: Arc<tui::Tail>,
    /// Prompts the composer already published, waiting for the transcript to
    /// echo them back so the reader is not shown the same message twice.
    pub echoed: std::collections::VecDeque<String>,
    /// Hook threads parked on a decision, by request id.
    pub decisions: HashMap<String, std::sync::mpsc::Sender<Decision>>,
    /// Tools already answered for in this turn, by the command they name.
    /// Codex fires `PreToolUse` and then `PermissionRequest` for the same
    /// call, and one tool must not cost the reader two cards.
    pub answered: HashMap<String, bool>,
}

pub enum Engine {
    Cli(CliTab),
    Acp(acp::Acp),
    OpenCode(opencode::OpenCode),
    None,
}

pub struct TabRuntime {
    pub session_id: String,
    pub tab_id: String,
    pub harness: String,
    pub seq: u64,
    pub status: TabStatus,
    pub child: Option<Arc<LiveChild>>,
    pub child_pid: Option<u32>,
    pub engine: Engine,
    pub pending: HashMap<String, PendingAsk>,
    pub queued: Vec<QueuedMessage>,
    pub turn_open: bool,
    pub turn_started_at: Option<Instant>,
    pub last_activity: Instant,
    pub log_path: std::path::PathBuf,
    /// Back-reference so work finished off-thread (an HTTP reply) can re-enter.
    pub me: std::sync::Weak<Mutex<TabRuntime>>,
}

impl TabRuntime {
    fn key(&self) -> String {
        format!("{}/{}", self.session_id, self.tab_id)
    }
}

#[derive(Clone)]
pub struct SessionManager {
    app: AppHandle,
    host: Arc<Host>,
    terminals: Arc<pty::Terminals>,
    codex_models: Arc<codex::models::Cache>,
    tabs: Arc<Mutex<HashMap<String, Arc<Mutex<TabRuntime>>>>>,
    /// One lock per pane, so two prompts sent in quick succession cannot
    /// interleave their paste and their Enter.
    writers: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    starts: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffInfo {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    pub harness: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabStatusEvent {
    pub session_id: String,
    pub tab_id: String,
    pub status: TabStatus,
}

/// Told to the frontend when a tab's CLI gets its terminal pane, so the pane
/// can be adopted by the tab's terminal view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabPtyEvent {
    pub session_id: String,
    pub tab_id: String,
    pub pane_id: String,
    pub command: String,
    pub harness: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub queued: bool,
    pub events: Vec<AgentEvent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub media_type: String,
    pub data: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// Archived image refs for the log, and (media type, base64) pairs for the wire.
type ArchivedImages = (Vec<ImageRef>, Vec<(String, String)>);

fn key_of(session_id: &str, tab_id: &str) -> String {
    format!("{session_id}/{tab_id}")
}

/// What one tool call is, for the purpose of not asking about it twice. The
/// same command reaches `PreToolUse` and `PermissionRequest` under different
/// ids but with the same input, minus the justification Codex adds.
fn tool_key(tool_name: &str, input: &Value) -> String {
    let target = ["command", "file_path", "path", "pattern", "query", "url"].iter().find_map(|k| input.get(*k).and_then(Value::as_str)).unwrap_or_default();
    format!("{tool_name}\u{1}{target}")
}

/// The reader's decision as the hook that asked has to print it.
fn reply_for(kind: CliKind, event: &str, decision: Decision) -> HookReply {
    let allow = !matches!(decision, Decision::Deny);
    let output = match (kind, event) {
        (CliKind::Claude, _) => {
            let (input, perms) = match decision {
                Decision::AllowWith(s) => (None, vec![s]),
                Decision::Answers(v) => (Some(v), Vec::new()),
                _ => (None, Vec::new()),
            };
            claude::pty::permission_decision(allow, input, perms)
        }
        (CliKind::Codex, "PreToolUse") => codex::pty::pre_tool_decision(allow),
        (CliKind::Codex, _) => codex::pty::permission_decision(allow),
    };
    HookReply { output: Some(output) }
}

/// Which CLI a harness runs as its tab, or `None` for the harnesses that are
/// still driven headless.
pub fn pty_first(harness: &str) -> Option<CliKind> {
    match HarnessId::parse(harness) {
        HarnessId::Claude => Some(CliKind::Claude),
        HarnessId::Codex => Some(CliKind::Codex),
        _ => None,
    }
}

impl SessionManager {
    pub fn new(app: AppHandle, host: Arc<Host>, terminals: Arc<pty::Terminals>, codex_models: Arc<codex::models::Cache>) -> Self {
        Self {
            app,
            host,
            terminals,
            codex_models,
            tabs: Arc::new(Mutex::new(HashMap::new())),
            writers: Arc::new(Mutex::new(HashMap::new())),
            starts: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    fn runtime(&self, session_id: &str, tab_id: &str) -> Result<Arc<Mutex<TabRuntime>>> {
        let key = key_of(session_id, tab_id);
        if let Some(r) = self.tabs.lock().unwrap().get(&key) {
            return Ok(r.clone());
        }
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab {tab_id} not found"))?;
        let log_path = store::log_path(session_id, tab_id)?;
        let seq = store::last_seq(&log_path)?;
        let rt = Arc::new(Mutex::new(TabRuntime {
            session_id: session_id.into(),
            tab_id: tab_id.into(),
            harness: tab.harness.clone(),
            seq,
            status: TabStatus::Idle,
            child: None,
            child_pid: None,
            engine: Engine::None,
            pending: HashMap::new(),
            queued: Vec::new(),
            turn_open: false,
            turn_started_at: None,
            last_activity: Instant::now(),
            log_path,
            me: std::sync::Weak::new(),
        }));
        rt.lock().unwrap().me = Arc::downgrade(&rt);
        self.tabs.lock().unwrap().insert(key, rt.clone());
        Ok(rt)
    }

    /// Stamp, persist, emit. The one path every event takes.
    fn publish(&self, rt: &mut TabRuntime, payload: Payload, subagent: Option<SubagentRef>) -> AgentEvent {
        rt.seq += 1;
        let ev = AgentEvent {
            id: uuid::Uuid::now_v7().to_string(),
            session_id: rt.session_id.clone(),
            tab_id: rt.tab_id.clone(),
            harness: rt.harness.clone(),
            seq: rt.seq,
            ts: index::now(),
            subagent,
            payload,
        };
        if ev.payload.is_persisted() {
            if let Ok(line) = serde_json::to_string(&ev) {
                if let Err(e) = store::append_line(&rt.log_path, &line) {
                    log::error!("append {}: {e:#}", rt.log_path.display());
                }
            }
        }
        let _ = self.app.emit("agent_event", &ev);
        ev
    }

    fn set_status(&self, rt: &mut TabRuntime, status: TabStatus) {
        if rt.status == status {
            return;
        }
        rt.status = status;
        let _ = self.app.emit("tab_status", TabStatusEvent { session_id: rt.session_id.clone(), tab_id: rt.tab_id.clone(), status });
        let (sid, tid) = (rt.session_id.clone(), rt.tab_id.clone());
        // Persist off the hot path; the index write takes a lock and a rename.
        std::thread::spawn(move || {
            let _ = index::update_tab(&sid, &tid, |t| {
                t.status = status;
                Ok(())
            });
        });
    }

    /// The log, with any ask the running child is not actually waiting on
    /// retired as lapsed — only the child that asked can answer, and no child
    /// survives a restart, so a replayed card would have dead buttons.
    pub fn load_events(&self, session_id: &str, tab_id: &str) -> Result<Vec<AgentEvent>> {
        let path = store::log_path(session_id, tab_id)?;
        let mut events: Vec<AgentEvent> = store::read_lines(&path)?;
        let mut open: Vec<(String, Option<String>)> = Vec::new();
        for ev in &events {
            match &ev.payload {
                Payload::PermissionRequested { request_id, tool_use_id, .. } | Payload::QuestionsAsked { request_id, tool_use_id, .. } => {
                    open.push((request_id.clone(), Some(tool_use_id.clone())));
                }
                Payload::PermissionDecided { request_id, .. } => open.retain(|(r, _)| r != request_id),
                _ => {}
            }
        }
        if !open.is_empty() {
            let rt_arc = self.runtime(session_id, tab_id)?;
            let mut rt = rt_arc.lock().unwrap();
            let lapsed: Vec<_> = open.into_iter().filter(|(r, _)| !rt.pending.contains_key(r)).collect();
            for (request_id, tool_use_id) in lapsed {
                let ev = self.publish(&mut rt, Payload::PermissionDecided { request_id, tool_use_id, allowed: false, label: "Lapsed".into(), automatic: true }, None);
                events.push(ev);
            }
        }
        Ok(events)
    }

    pub fn status_of(&self, session_id: &str, tab_id: &str) -> TabStatus {
        self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).map(|r| r.lock().unwrap().status).unwrap_or(TabStatus::Idle)
    }

    pub fn queued(&self, session_id: &str, tab_id: &str) -> Vec<QueuedMessage> {
        self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).map(|r| r.lock().unwrap().queued.clone()).unwrap_or_default()
    }

    fn archive_images(session_id: &str, images: &[ImageInput]) -> Result<ArchivedImages> {
        let mut refs = Vec::new();
        let mut wire = Vec::new();
        for (i, img) in images.iter().enumerate() {
            let ext = match img.media_type.as_str() {
                "image/jpeg" => "jpg",
                "image/gif" => "gif",
                "image/webp" => "webp",
                _ => "png",
            };
            let dir = store::attachments_dir(session_id)?;
            let path = dir.join(format!("{}-{i}.{ext}", uuid::Uuid::now_v7()));
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD.decode(&img.data).context("bad image base64")?;
            std::fs::write(&path, bytes)?;
            refs.push(ImageRef { url: path.to_string_lossy().into_owned(), media_type: Some(img.media_type.clone()), name: img.name.clone() });
            wire.push((img.media_type.clone(), img.data.clone()));
        }
        Ok((refs, wire))
    }

    fn spawn_child(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, program: &Path, args: &[String], cwd: &str) -> Result<()> {
        let sink = Arc::new(TabSink { manager: self.clone(), rt: rt_arc.clone() });
        let env = vec![("RACCOON_SESSION_ID".to_string(), rt.session_id.clone()), ("RACCOON_TAB_ID".to_string(), rt.tab_id.clone())];
        let child = self.host.spawn(&rt.key(), SpawnSpec { program, args, cwd: Path::new(cwd), env: &env }, sink)?;
        rt.child_pid = Some(child.pid);
        rt.child = Some(child);
        Ok(())
    }

    fn write(&self, rt: &TabRuntime, line: &str) -> Result<()> {
        rt.child.as_ref().context("the agent is not running")?.write_line(line)
    }

    /// Send a prompt. A tab mid-turn queues it for the next boundary.
    pub fn send(&self, session_id: &str, tab_id: &str, text: String, images: Vec<ImageInput>) -> Result<SendOutcome> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        let mut rt = rt_arc.lock().unwrap();
        let (refs, wire_images) = Self::archive_images(session_id, &images)?;

        if pty_first(&tab.harness).is_some() {
            return self.send_to_cli(&mut rt, &rt_arc, &entry, &tab, text, refs);
        }

        if rt.turn_open && rt.child.is_some() {
            let q = QueuedMessage { id: uuid::Uuid::now_v7().to_string(), text: text.clone(), images: wire_images };
            rt.queued.push(q);
            let ev = self.publish(&mut rt, Payload::UserMessage { text, images: refs, baseline: None, queued: true, cwd: Some(entry.cwd.clone()) }, None);
            return Ok(SendOutcome { queued: true, events: vec![ev] });
        }

        if rt.child.is_none() {
            match HarnessId::parse(&tab.harness) {
                HarnessId::Claude | HarnessId::Codex => bail!("that agent runs its own CLI"),
                HarnessId::Acp(binary) => self.start_acp(&mut rt, &rt_arc, &tab, &entry.cwd, &binary)?,
                HarnessId::OpenCode => self.start_opencode(&mut rt, &rt_arc, &tab, &entry.cwd)?,
                HarnessId::Other(name) => bail!("The {name} agent is not wired up yet."),
            }
        }

        let baseline = git::snapshot_tree(Path::new(&entry.cwd)).ok();
        let events = vec![self.publish(&mut rt, Payload::UserMessage { text: text.clone(), images: refs, baseline, queued: false, cwd: Some(entry.cwd.clone()) }, None)];

        match &mut rt.engine {
            Engine::Acp(a) => {
                let actions = if a.ready { a.prompt(text.clone(), wire_images) } else { a.start(text.clone(), wire_images) };
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => {
                let actions = if o.ready { o.prompt(text.clone(), wire_images) } else { o.start(text.clone(), wire_images) };
                self.apply_actions(&mut rt, actions);
            }
            Engine::Cli(_) | Engine::None => bail!("no engine"),
        }
        rt.turn_open = true;
        rt.turn_started_at = Some(Instant::now());
        rt.last_activity = Instant::now();
        self.set_status(&mut rt, TabStatus::InProgress);
        Ok(SendOutcome { queued: false, events })
    }

    fn start_acp(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, tab: &TabEntry, cwd: &str, binary: &str) -> Result<()> {
        let plan = acp::spawn_plan(binary).ok_or_else(|| anyhow!("{binary} is not installed. Install it and log in, then try again."))?;
        rt.engine = Engine::Acp(acp::Acp::new(cwd, tab.provider_session_id.clone(), Some(tab.model.clone()).filter(|m| !m.is_empty()), &tab.permission_mode));
        self.spawn_child(rt, rt_arc, &plan.program, &plan.args, cwd).with_context(|| format!("start {binary}"))?;
        Ok(())
    }

    fn start_opencode(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, tab: &TabEntry, cwd: &str) -> Result<()> {
        let plan = opencode::spawn_plan().ok_or_else(|| anyhow!("OpenCode is not installed. Install it and log in, then try again."))?;
        rt.engine = Engine::OpenCode(opencode::OpenCode::new(plan.port, cwd, tab.provider_session_id.clone(), Some(tab.model.clone()).filter(|m| !m.is_empty()), &tab.permission_mode));
        self.spawn_child(rt, rt_arc, &plan.program, &plan.args, cwd).context("start OpenCode")?;
        let pid = rt.child_pid;
        let base = format!("http://127.0.0.1:{}", plan.port);
        let manager = self.clone();
        let rt_weak = Arc::downgrade(rt_arc);
        std::thread::Builder::new()
            .name("opencode-events".into())
            .spawn(move || {
                let alive = || rt_weak.upgrade().map(|r| r.lock().map(|g| g.child_pid == pid).unwrap_or(false)).unwrap_or(false);
                let emit = |line: String| {
                    if let Some(r) = rt_weak.upgrade() {
                        manager.on_line(&r, &line);
                    }
                };
                opencode::pump_events(&base, alive, emit);
            })
            .context("event pump")?;
        Ok(())
    }

    fn apply_actions(&self, rt: &mut TabRuntime, actions: Vec<Action>) {
        for a in actions {
            match a {
                Action::Http { tag, method, url, body } => {
                    let manager = self.clone();
                    let me = rt.me.clone();
                    std::thread::spawn(move || {
                        let line = opencode::perform(&tag, &method, &url, body);
                        if let Some(r) = me.upgrade() {
                            manager.on_line(&r, &line);
                        }
                    });
                }
                Action::Write(line) => {
                    if let Err(e) = self.write(rt, &line) {
                        log::error!("[{}] write: {e:#}", rt.key());
                    }
                }
                Action::Emit(p) => self.apply(rt, p, None),
                Action::ThreadReady(id) => {
                    let (s, t) = (rt.session_id.clone(), rt.tab_id.clone());
                    std::thread::spawn(move || {
                        let _ = index::update_tab(&s, &t, |tab| {
                            tab.provider_session_id = Some(id);
                            Ok(())
                        });
                    });
                }
            }
        }
    }

    pub fn interrupt(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        rt.queued.clear();
        if rt.child.is_none() && !matches!(rt.engine, Engine::Cli(_)) {
            return Ok(());
        }
        match &mut rt.engine {
            // The TUI reads a bare Escape as "stop"; nothing else can reach it.
            Engine::Cli(p) => {
                let _ = self.terminals.write(&p.pane_id, tui::ESCAPE);
            }
            Engine::Acp(a) => {
                let actions = a.interrupt();
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => {
                let actions = o.interrupt();
                self.apply_actions(&mut rt, actions);
            }
            Engine::None => {}
        }
        Ok(())
    }

    pub fn cancel_queued(&self, session_id: &str, tab_id: &str, message_id: &str) -> Result<Option<QueuedMessage>> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        let pos = rt.queued.iter().position(|q| q.id == message_id);
        Ok(pos.map(|p| rt.queued.remove(p)))
    }

    /// Kill the agent but keep resume state, so the next prompt resumes.
    pub fn stop(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let key = key_of(session_id, tab_id);
        self.host.kill(&key);
        let rt = self.tabs.lock().unwrap().get(&key).cloned();
        if let Some(rt) = rt {
            let mut rt = rt.lock().unwrap();
            rt.child = None;
            rt.child_pid = None;
            if matches!(rt.engine, Engine::Cli(_)) {
                self.stop_cli(&mut rt);
            }
        }
        Ok(())
    }

    pub fn respond_permission(&self, session_id: &str, tab_id: &str, request_id: &str, option_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.child.is_none() && !matches!(rt.engine, Engine::Cli(_)) {
            rt.pending.remove(request_id);
            bail!("the agent is no longer running; the request lapsed");
        }
        let ask = rt.pending.remove(request_id).ok_or_else(|| anyhow!("that request is no longer open"))?;
        let (allow, label) = match &mut rt.engine {
            Engine::Cli(p) => {
                let (decision, label) = match option_id {
                    "deny" => (Decision::Deny, "Denied".to_string()),
                    "allow" => (Decision::Allow, "Allowed".to_string()),
                    s if s.starts_with("suggest:") => {
                        let i: usize = s[8..].parse().unwrap_or(usize::MAX);
                        let sugg = ask.suggestions.get(i).cloned().ok_or_else(|| anyhow!("unknown option"))?;
                        (Decision::AllowWith(sugg), "Allowed always".to_string())
                    }
                    _ => bail!("unknown option"),
                };
                let allow = !matches!(decision, Decision::Deny);
                let tx = p.decisions.remove(request_id).ok_or_else(|| anyhow!("the agent stopped waiting for that request"))?;
                let _ = tx.send(decision);
                (allow, label)
            }
            Engine::Acp(a) => {
                let actions = a.answer(request_id, option_id).ok_or_else(|| anyhow!("that request is no longer open"))?;
                let allow = !(option_id.contains("cancel") || option_id.contains("reject") || option_id.contains("deny"));
                self.apply_actions(&mut rt, actions);
                (allow, if allow { "Allowed".to_string() } else { "Denied".to_string() })
            }
            Engine::OpenCode(o) => {
                let actions = o.answer(request_id, option_id).ok_or_else(|| anyhow!("that request is no longer open"))?;
                let allow = option_id != "reject";
                self.apply_actions(&mut rt, actions);
                (allow, if allow { "Allowed".to_string() } else { "Denied".to_string() })
            }
            Engine::None => bail!("no engine"),
        };
        self.publish(&mut rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: Some(ask.tool_use_id), allowed: allow, label, automatic: false }, None);
        if rt.pending.is_empty() {
            self.set_status(&mut rt, TabStatus::InProgress);
        }
        Ok(())
    }

    /// Answer an AskUserQuestion: the answers ride inside an allow.
    pub fn answer_questions(&self, session_id: &str, tab_id: &str, request_id: &str, answers: HashMap<String, String>) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        let ask = rt.pending.remove(request_id).ok_or_else(|| anyhow!("that question is no longer open"))?;
        let mut input = ask.input.clone();
        input["answers"] = serde_json::to_value(&answers)?;
        match &mut rt.engine {
            Engine::Cli(p) if p.harness == CliKind::Claude => {
                let tx = p.decisions.remove(request_id).ok_or_else(|| anyhow!("the agent stopped waiting for that question"))?;
                let _ = tx.send(Decision::Answers(input));
            }
            _ => bail!("that agent does not ask questions this way"),
        }
        self.publish(&mut rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: Some(ask.tool_use_id), allowed: true, label: "Answered".into(), automatic: false }, None);
        if rt.pending.is_empty() {
            self.set_status(&mut rt, TabStatus::InProgress);
        }
        Ok(())
    }

    pub fn set_model(&self, session_id: &str, tab_id: &str, model: &str) -> Result<()> {
        index::update_tab(session_id, tab_id, |t| {
            t.model = model.into();
            Ok(())
        })?;
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        let mut restart = false;
        match &mut rt.engine {
            // Claude's own `/model` takes the change live. Codex's `/model`
            // opens a picker rather than taking an argument, so its tab is
            // restarted on the same conversation instead.
            Engine::Cli(p) if p.harness == CliKind::Claude => self.type_command(&p.pane_id, format!("/model {model}")),
            Engine::Cli(_) => restart = !rt.turn_open,
            Engine::Acp(a) => {
                let actions = a.set_model(model);
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => o.model = Some(model.into()),
            _ => {}
        }
        if restart {
            self.restart_cli(&mut rt, &rt_arc, session_id, tab_id)?;
        }
        self.publish(&mut rt, Payload::SettingsChanged { model: Some(model.into()), effort: None, permission_mode: None }, None);
        Ok(())
    }

    pub fn set_permission_mode(&self, session_id: &str, tab_id: &str, mode: &str) -> Result<()> {
        index::update_tab(session_id, tab_id, |t| {
            t.permission_mode = mode.into();
            Ok(())
        })?;
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        let turn_open = rt.turn_open;
        let mut restart = false;
        match &mut rt.engine {
            // Neither TUI has a command for this — Claude cycles it on a key,
            // Codex fixes the sandbox at launch. Restarting the CLI on the
            // same conversation is lossless and immediate.
            Engine::Cli(_) => restart = !turn_open,
            Engine::Acp(a) => {
                let actions = a.set_mode(mode);
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => o.mode = mode.into(),
            _ => {}
        }
        if restart {
            self.restart_cli(&mut rt, &rt_arc, session_id, tab_id)?;
        } else if matches!(rt.engine, Engine::Cli(_)) {
            self.publish(&mut rt, Payload::Status { text: format!("{} applies when the agent next starts.", claude::mapper::mode_label(mode)) }, None);
        }
        self.publish(&mut rt, Payload::SettingsChanged { model: None, effort: None, permission_mode: Some(mode.into()) }, None);
        Ok(())
    }

    /// Claude takes effort live through its own `/effort`. Codex has no such
    /// command, so its tab is restarted on the same conversation; the
    /// headless peers respawn.
    pub fn set_effort(&self, session_id: &str, tab_id: &str, effort: Option<&str>) -> Result<()> {
        index::update_tab(session_id, tab_id, |t| {
            t.effort = effort.map(String::from);
            Ok(())
        })?;
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        let turn_open = rt.turn_open;
        let mut respawn = false;
        let mut restart = false;
        match &mut rt.engine {
            Engine::Cli(p) if p.harness == CliKind::Claude => {
                if let Some(e) = effort.filter(|e| !e.is_empty()) {
                    self.type_command(&p.pane_id, format!("/effort {e}"));
                }
            }
            Engine::Cli(_) => restart = !turn_open,
            Engine::Acp(_) | Engine::OpenCode(_) => {}
            _ => respawn = !turn_open,
        }
        if respawn {
            self.host.kill(&rt.key());
            rt.child = None;
            rt.child_pid = None;
            rt.engine = Engine::None;
        }
        if restart {
            self.restart_cli(&mut rt, &rt_arc, session_id, tab_id)?;
        }
        self.publish(&mut rt, Payload::SettingsChanged { model: None, effort: effort.map(String::from), permission_mode: None }, None);
        Ok(())
    }

    pub fn mark_read(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.status == TabStatus::Completed {
            self.set_status(&mut rt, TabStatus::Idle);
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        self.host.kill_all();
    }

    // ---- Claude, PTY-first

    /// The terminal pane a tab's CLI runs in. Derived from the tab id so the
    /// frontend can find the same pane without being told.
    pub fn pane_id(tab_id: &str) -> String {
        format!("tab:{tab_id}")
    }

    /// Start the tab's CLI if it is not already running. Idempotent: opening a
    /// tab, sending a prompt and switching to the terminal view all call it.
    pub fn ensure_started(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        if pty_first(&tab.harness).is_none() {
            return Ok(());
        }
        let mut rt = rt_arc.lock().unwrap();
        self.start_cli(&mut rt, &rt_arc, &entry, &tab)?;
        Ok(())
    }

    /// Returns whether this call is what started it, so a prompt sent in the
    /// same breath knows to wait for the TUI to finish drawing.
    fn start_cli(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry, tab: &TabEntry) -> Result<bool> {
        let Some(kind) = pty_first(&tab.harness) else { return Ok(false) };
        let pane = Self::pane_id(&tab.id);
        if let Engine::Cli(p) = &rt.engine {
            if p.pane_id == pane && self.terminals.is_running(&pane) {
                return Ok(false);
            }
        }
        self.terminals.kill(&pane);

        let exe = std::env::current_exe().context("locate this binary for the CLI's hooks")?;
        let mut env = vec![
            ("RACCOON_SESSION_ID".to_string(), rt.session_id.clone()),
            ("RACCOON_TAB_ID".to_string(), rt.tab_id.clone()),
        ];
        match crate::hooks::socket_path() {
            Ok(p) => env.push((crate::hooks::SOCKET_ENV.to_string(), p.to_string_lossy().into_owned())),
            // Without the socket the CLI still runs; the chat just loses the
            // status and permission half until the app is restarted.
            Err(e) => log::warn!("no hook socket: {e:#}"),
        }
        let launch = match kind {
            CliKind::Claude => self.claude_launch(entry, tab, &exe)?,
            CliKind::Codex => self.codex_launch(rt, entry, tab, &exe, &mut env)?,
        };

        let tail = Arc::new(launch.tail);
        let spec = pty::PaneSpec { cwd: &entry.cwd, cols: 120, rows: 30, command: Some(&launch.command), env: &env };
        self.terminals.spawn(self.app.clone(), &pane, spec).context("start the agent's CLI")?;
        let generation = self.starts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        rt.engine = Engine::Cli(CliTab {
            harness: kind,
            mode: tab.permission_mode.clone(),
            pane_id: pane.clone(),
            generation,
            tail: tail.clone(),
            echoed: Default::default(),
            decisions: HashMap::new(),
            answered: HashMap::new(),
        });
        rt.turn_open = false;
        let _ = self.app.emit(
            "tab_pty",
            TabPtyEvent { session_id: rt.session_id.clone(), tab_id: rt.tab_id.clone(), pane_id: pane.clone(), command: launch.command, harness: tab.harness.clone() },
        );
        if let Some(id) = launch.minted {
            index::update_tab(&rt.session_id, &rt.tab_id, |t| {
                t.provider_session_id = Some(id.clone());
                t.fork_from = None;
                Ok(())
            })?;
        }
        self.follow_transcript(rt_arc, tail, pane, generation);
        Ok(true)
    }

    /// Claude Code: the app mints the conversation id, so the transcript's
    /// path is known before the CLI has written a byte.
    fn claude_launch(&self, entry: &index::SessionEntry, tab: &TabEntry, exe: &Path) -> Result<CliLaunch> {
        let provider_id = tab.provider_session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let resume = tab.provider_session_id.is_some();
        let fork_from = if resume { None } else { tab.fork_from.clone() };
        let settings = claude::pty::settings_json(exe);
        let command = claude::pty::launch_command(claude::pty::LaunchOptions {
            provider_session_id: &provider_id,
            resume,
            fork_from: fork_from.as_deref(),
            model: &tab.model,
            effort: tab.effort.as_deref(),
            permission_mode: &tab.permission_mode,
            title: tab.title.as_deref(),
            settings: &settings,
        })
        .ok_or_else(|| anyhow!("Claude Code is not installed. Install it and log in, then try again."))?;

        // The CLI's trust dialog would take the first prompt instead of the
        // composer, and a session's worktree is always a folder it has not
        // seen. The reader adopted this checkout when they made the session.
        if let Err(e) = claude::trust::ensure_trusted(&entry.cwd) {
            log::warn!("trust {}: {e:#}", entry.cwd);
        }
        let path = claude::transcript::cli_transcript_path(&entry.cwd, &provider_id).ok_or_else(|| anyhow!("no home directory"))?;
        Ok(CliLaunch {
            command,
            tail: tui::Tail::opening(path, claude::transcript::decode_line),
            minted: (!resume).then_some(provider_id),
        })
    }

    /// Codex: the CLI mints its own conversation id and names the rollout
    /// after it, so a new tab has nothing to follow until its `SessionStart`
    /// hook says which file it opened. A tab that already holds an id follows
    /// that rollout from wherever it stands.
    fn codex_launch(&self, rt: &mut TabRuntime, entry: &index::SessionEntry, tab: &TabEntry, exe: &Path, env: &mut Vec<(String, String)>) -> Result<CliLaunch> {
        // A tab stored before the account's list was known can name a model
        // this account cannot run; sending it would fail the turn with a 400.
        let model = match self.codex_models.substitute_for(&tab.model) {
            Some(sub) => {
                let text = format!("{} is not available on this account; using {}.", tab.model, sub.label);
                self.publish(rt, Payload::Status { text }, None);
                let _ = index::update_tab(&rt.session_id, &rt.tab_id, |t| {
                    t.model = sub.id.clone();
                    Ok(())
                });
                self.publish(rt, Payload::SettingsChanged { model: Some(sub.id.clone()), effort: None, permission_mode: None }, None);
                sub.id
            }
            None => tab.model.clone(),
        };

        let home = codex::home::prepare(&entry.cwd, exe).context("prepare the Codex home")?;
        env.push(("CODEX_HOME".to_string(), home.to_string_lossy().into_owned()));

        // A conversation started by the old headless engine lives in the
        // reader's own home, where a `codex resume` against ours would not
        // look for it.
        let mut resume = tab.provider_session_id.clone();
        if let (Some(id), Some(user)) = (&resume, codex::home::user_root()) {
            match codex::home::adopt_rollout(&home, &user, id) {
                Ok(true) => log::info!("brought Codex conversation {id} into the managed home"),
                Ok(false) => {}
                Err(e) => log::warn!("could not adopt Codex conversation {id}: {e:#}"),
            }
        }
        let rollout = resume.as_deref().and_then(|id| codex::home::find_rollout(&home, id));
        if resume.is_some() && rollout.is_none() {
            // Resuming an id Codex cannot find fails the launch outright, so
            // the tab starts a new conversation and says so.
            self.publish(rt, Payload::Status { text: "The previous Codex conversation is no longer on this machine; starting a new one.".into() }, None);
            resume = None;
        }
        let command = codex::pty::launch_command(codex::pty::LaunchOptions {
            resume: resume.as_deref(),
            model: &model,
            effort: tab.effort.as_deref(),
            permission_mode: &tab.permission_mode,
        })
        .ok_or_else(|| anyhow!("Codex is not installed. Install it and log in, then try again."))?;
        Ok(CliLaunch {
            command,
            tail: match rollout {
                Some(path) => tui::Tail::opening(path, codex::rollout::decode_line),
                None => tui::Tail::unknown(codex::rollout::decode_line),
            },
            minted: None,
        })
    }

    /// Restart the CLI on the same conversation. Lossless, and the only way
    /// to change a flag a running TUI has no command for.
    fn restart_cli(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, session_id: &str, tab_id: &str) -> Result<()> {
        self.stop_cli(rt);
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        self.start_cli(rt, rt_arc, &entry, &tab)?;
        Ok(())
    }

    /// Stop the tab's CLI, keeping the conversation so the next prompt resumes.
    fn stop_cli(&self, rt: &mut TabRuntime) {
        if let Engine::Cli(p) = &rt.engine {
            self.terminals.kill(&p.pane_id);
        }
        rt.engine = Engine::None;
        rt.turn_open = false;
        self.set_status(rt, TabStatus::Idle);
    }

    /// Poll the transcript. The CLI appends without any signal to subscribe
    /// to, and the file may not exist for a second or two after the CLI
    /// starts, so a stat every 200 ms is both the simplest and the surest way
    /// to follow it. The same loop notices the pane dying.
    fn follow_transcript(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: Arc<tui::Tail>, pane: String, generation: u64) {
        let manager = self.clone();
        let weak = Arc::downgrade(rt_arc);
        let _ = std::thread::Builder::new().name(format!("transcript-{pane}")).spawn(move || loop {
            std::thread::sleep(tui::POLL_INTERVAL);
            let Some(rt_arc) = weak.upgrade() else { return };
            let mine = matches!(&rt_arc.lock().unwrap().engine, Engine::Cli(p) if p.generation == generation);
            if !mine {
                return;
            }
            manager.pump(&rt_arc, &tail);
            if !manager.terminals.is_running(&pane) {
                let mut rt = rt_arc.lock().unwrap();
                if matches!(&rt.engine, Engine::Cli(p) if p.generation == generation) {
                    manager.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                    rt.engine = Engine::None;
                    manager.set_status(&mut rt, TabStatus::Idle);
                }
                return;
            }
        });
    }

    /// Publish everything the transcript has gained since the last look. The
    /// tail's own lock orders this against the poll loop, so a `Stop` hook
    /// flushing before it closes the turn cannot overtake it.
    fn pump(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>) {
        let payloads = tail.drain();
        if payloads.is_empty() {
            return;
        }
        let mut rt = rt_arc.lock().unwrap();
        rt.last_activity = Instant::now();
        for payload in payloads {
            // A prompt sent from the composer was published when it was sent;
            // the transcript's copy of it would be the same message twice.
            if let (Payload::UserMessage { text, .. }, Engine::Cli(p)) = (&payload, &mut rt.engine) {
                if p.echoed.front().is_some_and(|q| q == text) {
                    p.echoed.pop_front();
                    continue;
                }
            }
            if matches!(payload, Payload::UserMessage { .. }) {
                rt.turn_open = true;
                self.set_status(&mut rt, TabStatus::InProgress);
            }
            self.apply(&mut rt, payload, None);
        }
    }

    fn close_open_turn(&self, rt: &mut TabRuntime, status: TurnStatus, final_text: Option<String>) {
        if !rt.turn_open {
            return;
        }
        let duration_ms = rt.turn_started_at.map(|t| t.elapsed().as_millis() as u64);
        self.apply(rt, Payload::TurnCompleted { status, final_text, usage: None, duration_ms, head: None, auth_failed: false }, None);
    }

    /// Send a prompt to the CLI as keystrokes. A tab mid-turn writes anyway:
    /// the TUI queues typed input itself, so the message is only *shown* as
    /// queued until the CLI takes it and the transcript says so.
    fn send_to_cli(
        &self,
        rt: &mut TabRuntime,
        rt_arc: &Arc<Mutex<TabRuntime>>,
        entry: &index::SessionEntry,
        tab: &TabEntry,
        text: String,
        images: Vec<ImageRef>,
    ) -> Result<SendOutcome> {
        let just_started = self.start_cli(rt, rt_arc, entry, tab)?;
        let pane = match &rt.engine {
            Engine::Cli(p) => p.pane_id.clone(),
            _ => bail!("the agent is not running"),
        };
        let queued = rt.turn_open;
        let baseline = if queued { None } else { git::snapshot_tree(Path::new(&entry.cwd)).ok() };
        let paths: Vec<String> = images.iter().map(|i| i.url.clone()).collect();
        if !queued {
            if let Engine::Cli(p) = &mut rt.engine {
                p.echoed.push_back(text.clone());
            }
        }
        let ev = self.publish(rt, Payload::UserMessage { text: text.clone(), images, baseline, queued, cwd: Some(entry.cwd.clone()) }, None);
        self.type_prompt(&pane, text, paths, just_started);
        if !queued {
            rt.turn_open = true;
            rt.turn_started_at = Some(Instant::now());
            self.set_status(rt, TabStatus::InProgress);
        }
        Ok(SendOutcome { queued, events: vec![ev] })
    }

    /// Write into a pane on its own thread, under that pane's write lock. The
    /// Enter has to be a later write than the body — a carriage return inside
    /// the same one is read as part of the paste and never submits — so this
    /// sleeps, which no caller holding the tab lock could afford to do.
    fn type_prompt(&self, pane: &str, text: String, attachments: Vec<String>, await_ready: bool) {
        let lock = self.writers.lock().unwrap().entry(pane.to_string()).or_default().clone();
        let terminals = self.terminals.clone();
        let pane = pane.to_string();
        let _ = std::thread::Builder::new().name("cli-input".into()).spawn(move || {
            let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
            // A TUI that is still drawing its first frame drops what is typed
            // at it. There is nothing to ask, so the sign it is listening is
            // that it has painted something and then gone quiet.
            if await_ready {
                let deadline = std::time::Instant::now() + tui::READY_TIMEOUT;
                while std::time::Instant::now() < deadline {
                    if terminals.quiet_for(&pane).is_some_and(|q| q >= tui::READY_QUIET) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
            let write = |bytes: &[u8]| {
                if let Err(e) = terminals.write(&pane, bytes) {
                    log::warn!("[{pane}] write: {e:#}");
                }
            };
            write(tui::CLEAR_LINE);
            for path in &attachments {
                write(&tui::attachment_bytes(path));
            }
            if !attachments.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            let body = tui::body_bytes(&text);
            write(&body);
            std::thread::sleep(tui::submit_delay(body.len()));
            write(tui::SUBMIT);
        });
    }

    /// A slash command the CLI runs itself (`/model`, `/effort`).
    fn type_command(&self, pane: &str, command: String) {
        self.type_prompt(pane, command, Vec::new(), false);
    }

    // ---- inbound from the CLI's hooks

    /// One hook occurrence. The reply is what the hook prints for the CLI, so
    /// only a permission decision ever carries anything.
    ///
    /// The event names are the same for both CLIs, and so is most of what
    /// they mean. Two are not: Claude's `Notification` says its own TUI is
    /// asking (Codex has no such event), and a Codex `PreToolUse` is a gate
    /// rather than a report when the reader has asked to see every tool.
    pub fn on_hook(&self, frame: HookFrame) -> HookReply {
        let Ok(rt_arc) = self.runtime(&frame.session, &frame.tab) else {
            return HookReply::default();
        };
        let (kind, tail, asks_every_tool) = {
            let rt = rt_arc.lock().unwrap();
            match &rt.engine {
                Engine::Cli(p) => (p.harness, p.tail.clone(), p.harness == CliKind::Codex && codex::asks_every_tool(&p.mode)),
                // A hook from a CLI this app did not start, or from one whose
                // tab has moved on: nothing to say, and nothing to block.
                _ => return HookReply::default(),
            }
        };
        // Claude's transcript path is a guess made before the CLI ran and
        // Codex's is not knowable at all until now; either way the hook
        // carries the file it actually opened.
        if let Some(path) = frame.payload["transcript_path"].as_str() {
            tail.retarget(Path::new(path));
        }
        self.pump(&rt_arc, &tail);

        match frame.event.as_str() {
            // Codex mints its own conversation id, so this is where the app
            // learns which one to resume next time.
            "SessionStart" => {
                if kind == CliKind::Codex {
                    if let Some(id) = frame.payload["session_id"].as_str() {
                        self.record_provider_session(&rt_arc, id);
                    }
                }
            }
            "PermissionRequest" => return self.ask_permission(&rt_arc, &frame, kind),
            // Codex asks twice about one escalating command: once here for
            // every tool, and again as a `PermissionRequest` when the sandbox
            // stops it. The reader answers once.
            "PreToolUse" if asks_every_tool => return self.ask_permission(&rt_arc, &frame, kind),
            "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => {
                let mut rt = rt_arc.lock().unwrap();
                rt.last_activity = Instant::now();
                if !rt.turn_open {
                    rt.turn_open = true;
                    rt.turn_started_at = Some(Instant::now());
                }
                if rt.pending.is_empty() {
                    self.set_status(&mut rt, TabStatus::InProgress);
                }
            }
            // The CLI is asking in its own TUI, which means our permission
            // hook did not answer in time. The reader has to go and look.
            "Notification" if frame.payload["notification_type"] == "permission_prompt" => {
                let mut rt = rt_arc.lock().unwrap();
                self.set_status(&mut rt, TabStatus::Waiting);
            }
            "Stop" => {
                let mut rt = rt_arc.lock().unwrap();
                rt.last_activity = Instant::now();
                let final_text = frame.payload["last_assistant_message"].as_str().map(String::from);
                self.forget_tool_answers(&mut rt);
                self.close_open_turn(&mut rt, TurnStatus::Ok, final_text);
            }
            // Codex only: the reader pressed Escape in the TUI.
            "Interrupt" => {
                let mut rt = rt_arc.lock().unwrap();
                self.forget_tool_answers(&mut rt);
                self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
            }
            "SessionEnd" => {
                let mut rt = rt_arc.lock().unwrap();
                self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                self.set_status(&mut rt, TabStatus::Idle);
            }
            _ => {}
        }
        HookReply::default()
    }

    fn record_provider_session(&self, rt_arc: &Arc<Mutex<TabRuntime>>, id: &str) {
        let (session_id, tab_id) = {
            let rt = rt_arc.lock().unwrap();
            (rt.session_id.clone(), rt.tab_id.clone())
        };
        let id = id.to_string();
        std::thread::spawn(move || {
            let _ = index::update_tab(&session_id, &tab_id, |t| {
                if t.provider_session_id.as_deref() != Some(&id) {
                    t.provider_session_id = Some(id);
                }
                Ok(())
            });
        });
    }

    /// Answers only stand for the turn they were given in.
    fn forget_tool_answers(&self, rt: &mut TabRuntime) {
        if let Engine::Cli(p) = &mut rt.engine {
            p.answered.clear();
        }
    }

    /// Turn a permission hook into the chat's own card and wait for it to be
    /// answered. The hook thread parks here, which is exactly what holds the
    /// CLI's tool call up until the reader decides.
    fn ask_permission(&self, rt_arc: &Arc<Mutex<TabRuntime>>, frame: &HookFrame, kind: CliKind) -> HookReply {
        let request_id = uuid::Uuid::now_v7().to_string();
        let tool_name = frame.payload["tool_name"].as_str().unwrap_or("tool").to_string();
        let input = frame.payload["tool_input"].clone();
        let suggestions: Vec<Value> = frame.payload["permission_suggestions"].as_array().cloned().unwrap_or_default();
        let gate = frame.event.as_str();

        // Codex raises `PermissionRequest` for a command the reader has just
        // been asked about at `PreToolUse`. Reusing that answer is what keeps
        // one tool to one card.
        if kind == CliKind::Codex {
            let key = tool_key(&tool_name, &input);
            let already = {
                let rt = rt_arc.lock().unwrap();
                match &rt.engine {
                    Engine::Cli(p) => p.answered.get(&key).copied(),
                    _ => None,
                }
            };
            if let Some(allow) = already {
                return reply_for(kind, gate, if allow { Decision::Allow } else { Decision::Deny });
            }
        }

        let (tx, rx) = std::sync::mpsc::channel::<Decision>();
        {
            let mut rt = rt_arc.lock().unwrap();
            let Engine::Cli(p) = &mut rt.engine else { return HookReply::default() };
            p.decisions.insert(request_id.clone(), tx);
            // The event carries no tool_use_id — it fires before the call is
            // recorded — so the card stands on its own rather than attaching
            // to a tool row.
            let payload = if tool_name == "AskUserQuestion" {
                Payload::QuestionsAsked { request_id: request_id.clone(), tool_use_id: String::new(), questions: claude::mapper::questions_from_input(&input) }
            } else {
                Payload::PermissionRequested {
                    request_id: request_id.clone(),
                    tool_use_id: String::new(),
                    title: Some(claude::mapper::tool_title(&tool_name, &input)),
                    // Codex explains itself in the tool input when it wants an
                    // escalation; Claude says nothing here.
                    description: input["description"].as_str().map(String::from),
                    options: claude::mapper::build_options(&suggestions),
                    tool_name: tool_name.clone(),
                    input: input.clone(),
                }
            };
            rt.pending.insert(request_id.clone(), PendingAsk { tool_use_id: String::new(), input: input.clone(), suggestions });
            self.apply(&mut rt, payload, None);
        }
        let wait = match kind {
            CliKind::Claude => claude::pty::PERMISSION_WAIT,
            CliKind::Codex => codex::pty::PERMISSION_WAIT,
        };
        let answer = rx.recv_timeout(wait).ok();
        let mut rt = rt_arc.lock().unwrap();
        if let Engine::Cli(p) = &mut rt.engine {
            p.decisions.remove(&request_id);
            if let Some(d) = &answer {
                p.answered.insert(tool_key(&tool_name, &input), !matches!(d, Decision::Deny));
            }
        }
        match answer {
            Some(decision) => reply_for(kind, gate, decision),
            None => {
                // The CLI has stopped waiting on us and will ask in its own
                // TUI; the card must stop offering buttons that go nowhere.
                self.apply(&mut rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
                HookReply::default()
            }
        }
    }

    /// Hand a headless tab to its CLI in a terminal: the child is stopped and
    /// the command that resumes the same conversation is returned. Refused
    /// mid-turn, because the CLI would otherwise resume a session another
    /// process is still writing.
    ///
    /// A PTY-first tab never comes here — its CLI is already the tab, so its
    /// terminal view is a view flag, not a hand-off.
    pub fn handoff(&self, session_id: &str, tab_id: &str) -> Result<HandoffInfo> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        {
            let rt = rt_arc.lock().unwrap();
            if rt.turn_open && rt.child.is_some() {
                bail!("Wait for the agent to finish, or stop it, before switching to the terminal.");
            }
        }
        self.stop(session_id, tab_id)?;
        {
            let mut rt = rt_arc.lock().unwrap();
            rt.engine = Engine::None;
            rt.turn_open = false;
            rt.queued.clear();
            self.set_status(&mut rt, TabStatus::Idle);
        }
        let command = match HarnessId::parse(&tab.harness) {
            HarnessId::Claude | HarnessId::Codex => bail!("That agent already runs its own CLI; use the terminal view."),
            HarnessId::Acp(binary) => binary,
            HarnessId::OpenCode => "opencode".into(),
            HarnessId::Other(name) => bail!("The {name} agent has no terminal form."),
        };
        Ok(HandoffInfo { command, provider_session_id: tab.provider_session_id.clone(), harness: tab.harness.clone() })
    }

    fn on_line(&self, rt_arc: &Arc<Mutex<TabRuntime>>, line: &str) {
        let mut rt = rt_arc.lock().unwrap();
        rt.last_activity = Instant::now();
        let actions = match &mut rt.engine {
            Engine::Acp(a) => a.handle(line),
            Engine::OpenCode(o) => o.handle(line),
            Engine::Cli(_) | Engine::None => return,
        };
        self.apply_actions(&mut rt, actions);
    }

    fn apply(&self, rt: &mut TabRuntime, payload: Payload, subagent: Option<SubagentRef>) {
        match &payload {
            Payload::TurnStarted { provider_session_id: Some(pid), .. } => {
                let (s, t, pid) = (rt.session_id.clone(), rt.tab_id.clone(), pid.clone());
                std::thread::spawn(move || {
                    let _ = index::update_tab(&s, &t, |tab| {
                        if tab.provider_session_id.as_deref() != Some(&pid) {
                            tab.provider_session_id = Some(pid);
                        }
                        Ok(())
                    });
                });
            }
            Payload::PermissionRequested { request_id, tool_use_id, input, .. } => {
                rt.pending.entry(request_id.clone()).or_insert_with(|| PendingAsk { tool_use_id: tool_use_id.clone(), input: input.clone(), suggestions: Vec::new() });
                self.set_status(rt, TabStatus::Waiting);
            }
            Payload::QuestionsAsked { .. } => self.set_status(rt, TabStatus::Waiting),
            Payload::PermissionDecided { request_id, automatic: true, .. } => {
                rt.pending.remove(request_id);
                if rt.pending.is_empty() && rt.status == TabStatus::Waiting {
                    self.set_status(rt, TabStatus::InProgress);
                }
            }
            _ => {}
        }

        let is_boundary = payload.is_turn_boundary();
        let payload = match payload {
            Payload::TurnCompleted { status, final_text, usage, duration_ms, auth_failed, .. } => {
                let head = index::get(&rt.session_id).ok().and_then(|e| git::snapshot_tree(Path::new(&e.cwd)).ok());
                if let Some(u) = &usage {
                    let (s, t) = (rt.session_id.clone(), rt.tab_id.clone());
                    let (cu, cm) = (u.context_used, u.context_max);
                    std::thread::spawn(move || {
                        let _ = index::update_tab(&s, &t, |tab| {
                            if cu.is_some() {
                                tab.context_used = cu;
                            }
                            if cm.is_some() {
                                tab.context_max = cm;
                            }
                            Ok(())
                        });
                    });
                }
                let duration_ms = duration_ms.or_else(|| rt.turn_started_at.map(|t| t.elapsed().as_millis() as u64));
                Payload::TurnCompleted { status, final_text, usage, duration_ms, head, auth_failed }
            }
            other => other,
        };
        self.publish(rt, payload, subagent);

        if is_boundary {
            rt.turn_open = false;
            if !rt.queued.is_empty() {
                let q = rt.queued.remove(0);
                let actions = match &mut rt.engine {
                    Engine::Acp(a) => a.prompt(q.text.clone(), q.images.clone()),
                    Engine::OpenCode(o) => o.prompt(q.text.clone(), q.images.clone()),
                    // A PTY tab never queues here: the CLI holds typed input
                    // itself, so the message went in when it was written.
                    Engine::Cli(_) | Engine::None => Vec::new(),
                };
                let sent = !actions.is_empty();
                self.apply_actions(rt, actions);
                if sent {
                    rt.turn_open = true;
                    rt.turn_started_at = Some(Instant::now());
                    return;
                }
            }
            self.set_status(rt, TabStatus::Completed);
        }
    }

    fn on_exit(&self, rt_arc: &Arc<Mutex<TabRuntime>>, pid: u32, code: Option<i32>) {
        let mut rt = rt_arc.lock().unwrap();
        if rt.child_pid != Some(pid) {
            return; // an older child; the live one is unaffected
        }
        rt.child = None;
        rt.child_pid = None;
        rt.engine = Engine::None;
        let pending: Vec<String> = rt.pending.drain().map(|(k, _)| k).collect();
        for request_id in pending {
            self.publish(&mut rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
        }
        if rt.turn_open {
            rt.turn_open = false;
            let duration_ms = rt.turn_started_at.map(|t| t.elapsed().as_millis() as u64);
            let status = if code == Some(0) { TurnStatus::Aborted } else { TurnStatus::Error };
            let final_text = (status == TurnStatus::Error).then(|| format!("The agent exited unexpectedly (code {}).", code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into())));
            self.publish(&mut rt, Payload::TurnCompleted { status, final_text, usage: None, duration_ms, head: None, auth_failed: false }, None);
        }
        rt.queued.clear();
        self.set_status(&mut rt, TabStatus::Idle);
    }
}

struct TabSink {
    manager: SessionManager,
    rt: Arc<Mutex<TabRuntime>>,
}

impl Sink for TabSink {
    fn stdout_line(&self, line: String) {
        self.manager.on_line(&self.rt, &line);
    }
    fn stderr_line(&self, line: String) {
        let key = self.rt.lock().map(|r| r.key()).unwrap_or_default();
        log::info!("[{key}] stderr: {line}");
    }
    fn exited(&self, pid: u32, code: Option<i32>) {
        self.manager.on_exit(&self.rt, pid, code);
    }
}
