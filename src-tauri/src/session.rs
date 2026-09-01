//! The session manager: one runtime per tab, driving a harness child through
//! the host, numbering and persisting events, and answering the frontend.
//!
//! Status follows the turn alone: send → in_progress, `turn_completed` →
//! completed (meaning finished and unread), child exit → idle. A pending
//! permission or question marks the tab waiting until it is answered.
//!
//! Two engines: Claude Code is a pipe (parse → map per line); Codex is a peer
//! (a state machine answering each line with actions). The manager owns the
//! parts they share — the child, the seq counter, the log, the queue.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::events::*;
use crate::harness::codex::{self, Action};
use crate::harness::host::{Host, LiveChild, Sink, SpawnSpec};
use crate::harness::{acp, claude, opencode, HarnessId};
use crate::store::index::{self, TabEntry, TabStatus};
use crate::{git, store};

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

pub enum Engine {
    Claude(claude::mapper::Mapper),
    Codex(codex::Codex),
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
    tabs: Arc<Mutex<HashMap<String, Arc<Mutex<TabRuntime>>>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabStatusEvent {
    pub session_id: String,
    pub tab_id: String,
    pub status: TabStatus,
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
/// What one Claude line mapped to: payloads, the subagent stamp, and the
/// suggestion payloads plus ask input the mapper saw last.
type ClaudeLine = (Vec<Payload>, Option<SubagentRef>, Vec<Value>, Value);

fn key_of(session_id: &str, tab_id: &str) -> String {
    format!("{session_id}/{tab_id}")
}

impl SessionManager {
    pub fn new(app: AppHandle, host: Arc<Host>) -> Self {
        Self { app, host, tabs: Arc::new(Mutex::new(HashMap::new())) }
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

        if rt.turn_open && rt.child.is_some() {
            let q = QueuedMessage { id: uuid::Uuid::now_v7().to_string(), text: text.clone(), images: wire_images };
            rt.queued.push(q);
            let ev = self.publish(&mut rt, Payload::UserMessage { text, images: refs, baseline: None, queued: true, cwd: Some(entry.cwd.clone()) }, None);
            return Ok(SendOutcome { queued: true, events: vec![ev] });
        }

        if rt.child.is_none() {
            match HarnessId::parse(&tab.harness) {
                HarnessId::Claude => self.start_claude(&mut rt, &rt_arc, session_id, tab_id, &tab, &entry.cwd)?,
                HarnessId::Codex => self.start_codex(&mut rt, &rt_arc, &tab, &entry.cwd)?,
                HarnessId::Acp(binary) => self.start_acp(&mut rt, &rt_arc, &tab, &entry.cwd, &binary)?,
                HarnessId::OpenCode => self.start_opencode(&mut rt, &rt_arc, &tab, &entry.cwd)?,
                HarnessId::Other(name) => bail!("The {name} agent is not wired up yet."),
            }
        }

        let baseline = git::snapshot_tree(Path::new(&entry.cwd)).ok();
        let events = vec![self.publish(&mut rt, Payload::UserMessage { text: text.clone(), images: refs, baseline, queued: false, cwd: Some(entry.cwd.clone()) }, None)];

        match &mut rt.engine {
            Engine::Claude(m) => {
                let provider_id = index::get(session_id).ok().and_then(|e| e.tab(tab_id).and_then(|t| t.provider_session_id.clone())).unwrap_or_default();
                let line = claude::user_line(&provider_id, &text, &wire_images);
                m.begin_turn();
                self.write(&rt, &line)?;
            }
            Engine::Codex(c) => {
                let actions = if c.ready { c.prompt(text.clone(), wire_images) } else { c.start(text.clone(), wire_images) };
                self.apply_actions(&mut rt, actions);
            }
            Engine::Acp(a) => {
                let actions = if a.ready { a.prompt(text.clone(), wire_images) } else { a.start(text.clone(), wire_images) };
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => {
                let actions = if o.ready { o.prompt(text.clone(), wire_images) } else { o.start(text.clone(), wire_images) };
                self.apply_actions(&mut rt, actions);
            }
            Engine::None => bail!("no engine"),
        }
        rt.turn_open = true;
        rt.turn_started_at = Some(Instant::now());
        rt.last_activity = Instant::now();
        self.set_status(&mut rt, TabStatus::InProgress);
        Ok(SendOutcome { queued: false, events })
    }

    fn start_claude(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, session_id: &str, tab_id: &str, tab: &TabEntry, cwd: &str) -> Result<()> {
        let provider_id = tab.provider_session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let resume = tab.provider_session_id.is_some();
        let fork_from = if resume { None } else { tab.fork_from.clone() };
        let plan = claude::spawn_plan(claude::SpawnOptions {
            provider_session_id: &provider_id,
            resume,
            fork_from: fork_from.as_deref(),
            model: Some(&tab.model),
            effort: tab.effort.as_deref(),
            permission_mode: &tab.permission_mode,
        })
        .ok_or_else(|| anyhow!("Claude Code is not installed. Install it and log in, then try again."))?;
        rt.engine = Engine::Claude(claude::mapper::Mapper::new());
        self.spawn_child(rt, rt_arc, &plan.program, &plan.args, cwd).context("start Claude Code")?;
        if !resume {
            index::update_tab(session_id, tab_id, |t| {
                t.provider_session_id = Some(provider_id.clone());
                t.fork_from = None;
                Ok(())
            })?;
        }
        Ok(())
    }

    fn start_codex(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, tab: &TabEntry, cwd: &str) -> Result<()> {
        let plan = codex::spawn_plan().ok_or_else(|| anyhow!("Codex is not installed. Install it and log in, then try again."))?;
        rt.engine = Engine::Codex(codex::Codex::new(cwd, tab.provider_session_id.clone(), Some(tab.model.clone()), tab.effort.clone(), &tab.permission_mode));
        self.spawn_child(rt, rt_arc, &plan.program, &plan.args, cwd).context("start Codex")?;
        Ok(())
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
        if rt.child.is_none() {
            return Ok(());
        }
        match &mut rt.engine {
            Engine::Claude(m) => {
                m.interrupt_requested = true;
                let line = claude::interrupt_line(&uuid::Uuid::now_v7().to_string());
                self.write(&rt, &line)?;
            }
            Engine::Codex(c) => {
                let actions = c.interrupt();
                self.apply_actions(&mut rt, actions);
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

    /// Kill the child but keep resume state, so the next prompt resumes.
    pub fn stop(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let key = key_of(session_id, tab_id);
        self.host.kill(&key);
        if let Some(rt) = self.tabs.lock().unwrap().get(&key) {
            let mut rt = rt.lock().unwrap();
            rt.child = None;
            rt.child_pid = None;
        }
        Ok(())
    }

    pub fn respond_permission(&self, session_id: &str, tab_id: &str, request_id: &str, option_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.child.is_none() {
            rt.pending.remove(request_id);
            bail!("the agent is no longer running; the request lapsed");
        }
        let ask = rt.pending.remove(request_id).ok_or_else(|| anyhow!("that request is no longer open"))?;
        let (allow, label) = match &mut rt.engine {
            Engine::Claude(_) => {
                let (allow, label, perms) = match option_id {
                    "deny" => (false, "Denied".to_string(), Vec::new()),
                    "allow" => (true, "Allowed".to_string(), Vec::new()),
                    s if s.starts_with("suggest:") => {
                        let i: usize = s[8..].parse().unwrap_or(usize::MAX);
                        let sugg = ask.suggestions.get(i).cloned().ok_or_else(|| anyhow!("unknown option"))?;
                        (true, "Allowed always".to_string(), vec![sugg])
                    }
                    _ => bail!("unknown option"),
                };
                let line = claude::permission_response(request_id, allow, Some(ask.input.clone()), perms, None);
                self.write(&rt, &line)?;
                (allow, label)
            }
            Engine::Codex(c) => {
                let actions = c.answer(request_id, option_id).ok_or_else(|| anyhow!("that request is no longer open"))?;
                let allow = !option_id.contains("cancel");
                self.apply_actions(&mut rt, actions);
                (allow, if allow { "Allowed".to_string() } else { "Denied".to_string() })
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
        let line = claude::permission_response(request_id, true, Some(input), Vec::new(), None);
        self.write(&rt, &line)?;
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
        let has_child = rt.child.is_some();
        match &mut rt.engine {
            Engine::Claude(_) if has_child => {
                let line = claude::set_model_line(&uuid::Uuid::now_v7().to_string(), model);
                self.write(&rt, &line)?;
            }
            Engine::Codex(c) => c.model = Some(model.into()),
            Engine::Acp(a) => {
                let actions = a.set_model(model);
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => o.model = Some(model.into()),
            _ => {}
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
        let has_child = rt.child.is_some();
        let turn_open = rt.turn_open;
        let mut respawn = false;
        match &mut rt.engine {
            Engine::Claude(_) if has_child => {
                let line = claude::set_mode_line(&uuid::Uuid::now_v7().to_string(), mode);
                self.write(&rt, &line)?;
            }
            Engine::Codex(c) => {
                // The sandbox half only applies at thread start; a respawn lands it.
                c.mode = mode.into();
                respawn = !turn_open;
            }
            Engine::Acp(a) => {
                let actions = a.set_mode(mode);
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => o.mode = mode.into(),
            _ => {}
        }
        if respawn {
            self.host.kill(&rt.key());
            rt.child = None;
            rt.child_pid = None;
            rt.engine = Engine::None;
        }
        self.publish(&mut rt, Payload::SettingsChanged { model: None, effort: None, permission_mode: Some(mode.into()) }, None);
        Ok(())
    }

    /// Claude has no in-place effort control; the change lands on the next spawn.
    pub fn set_effort(&self, session_id: &str, tab_id: &str, effort: Option<&str>) -> Result<()> {
        index::update_tab(session_id, tab_id, |t| {
            t.effort = effort.map(String::from);
            Ok(())
        })?;
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        let turn_open = rt.turn_open;
        let mut respawn = false;
        match &mut rt.engine {
            Engine::Codex(c) => c.effort = effort.map(String::from),
            Engine::Acp(_) | Engine::OpenCode(_) => {}
            _ => respawn = !turn_open,
        }
        if respawn {
            self.host.kill(&rt.key());
            rt.child = None;
            rt.child_pid = None;
            rt.engine = Engine::None;
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

    // ---- inbound from the child

    fn on_line(&self, rt_arc: &Arc<Mutex<TabRuntime>>, line: &str) {
        let mut rt = rt_arc.lock().unwrap();
        rt.last_activity = Instant::now();
        let mut claude_out: Option<ClaudeLine> = None;
        let mut codex_out: Option<Vec<Action>> = None;
        match &mut rt.engine {
            Engine::Claude(mapper) => {
                let parsed = match claude::parser::parse_line(line) {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!("unparsed line: {e}: {}", &line[..line.len().min(200)]);
                        let _ = store::root().map(|r| store::append_line(&r.join("parse_failures.jsonl"), line));
                        return;
                    }
                };
                let mapped = mapper.map(parsed);
                claude_out = Some((mapped.payloads, mapped.subagent, mapper.last_suggestions.clone(), mapper.last_ask_input.clone()));
            }
            Engine::Codex(c) => codex_out = Some(c.handle(line)),
            Engine::Acp(a) => codex_out = Some(a.handle(line)),
            Engine::OpenCode(o) => codex_out = Some(o.handle(line)),
            Engine::None => {}
        }
        if let Some((payloads, subagent, suggestions, ask_input)) = claude_out {
            for payload in payloads {
                if let Payload::PermissionRequested { request_id, tool_use_id, input, .. } = &payload {
                    rt.pending.insert(request_id.clone(), PendingAsk { tool_use_id: tool_use_id.clone(), input: input.clone(), suggestions: suggestions.clone() });
                }
                if let Payload::QuestionsAsked { request_id, tool_use_id, .. } = &payload {
                    rt.pending.insert(request_id.clone(), PendingAsk { tool_use_id: tool_use_id.clone(), input: ask_input.clone(), suggestions: Vec::new() });
                }
                self.apply(&mut rt, payload, subagent.clone());
            }
        }
        if let Some(actions) = codex_out {
            self.apply_actions(&mut rt, actions);
        }
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
                let mut line_to_write: Option<String> = None;
                let mut codex_actions: Option<Vec<Action>> = None;
                match &mut rt.engine {
                    Engine::Claude(m) => {
                        let pid = index::get(&rt.session_id).ok().and_then(|e| e.tab(&rt.tab_id).and_then(|t| t.provider_session_id.clone())).unwrap_or_default();
                        m.begin_turn();
                        line_to_write = Some(claude::user_line(&pid, &q.text, &q.images));
                    }
                    Engine::Codex(c) => codex_actions = Some(c.prompt(q.text.clone(), q.images.clone())),
                    Engine::Acp(a) => codex_actions = Some(a.prompt(q.text.clone(), q.images.clone())),
                    Engine::OpenCode(o) => codex_actions = Some(o.prompt(q.text.clone(), q.images.clone())),
                    Engine::None => {}
                }
                let sent = if let Some(line) = line_to_write {
                    self.write(rt, &line).is_ok()
                } else if let Some(actions) = codex_actions {
                    let ok = !actions.is_empty();
                    self.apply_actions(rt, actions);
                    ok
                } else {
                    false
                };
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
