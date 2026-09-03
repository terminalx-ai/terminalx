//! The session manager: one runtime per tab, driving a harness child through
//! the host, numbering and persisting events, and answering the frontend.
//!
//! Status follows the turn alone: send → in_progress, `turn_completed` →
//! completed (meaning finished and unread), child exit → idle. A pending
//! permission or question marks the tab waiting until it is answered.
//!
//! Claude Code and Codex are PTY-first: the tab *is* the interactive CLI,
//! running in a terminal pane. Nothing is parsed off the wire — what was said
//! comes from the CLI's transcript file, what is happening comes from its
//! hooks, and what the reader types goes back in as keystrokes.
//!
//! ACP and OpenCode are still headless children — peers, each inbound line
//! answered with a list of actions. They are no longer offered for new tabs
//! (`harness::HIDDEN_HARNESSES`), but a tab already on one runs unchanged, so
//! everything below still serves them. The manager owns the parts both shapes
//! share — the child, the seq counter, the log, the queue.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::events::*;
use crate::harness::host::{Host, LiveChild, Sink, SpawnSpec};
use crate::harness::{acp, claude, codex, opencode, tui, Action, CliKind, HarnessId};
use crate::hooks::{HookFrame, HookReply, Origin};
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
    /// The only directory this launch's hooks may point the tail into.
    transcript_root: PathBuf,
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
    /// A setting the CLI only reads at startup, changed mid-turn. The restart
    /// waits for the turn to end.
    pub restart_when_idle: bool,
    /// Set when this CLI's `SessionStart` hook arrives; what the thread that
    /// types into the pane waits on.
    pub ready: Arc<tui::Ready>,
    pub tail: Arc<tui::Tail>,
    /// Prompts the composer already published, waiting for the transcript to
    /// echo them back so the reader is not shown the same message twice.
    pub echoed: std::collections::VecDeque<String>,
    /// Hook threads parked on a decision, by request id.
    pub decisions: HashMap<String, std::sync::mpsc::Sender<Decision>>,
    /// Keeps the turn's reply from being drawn twice when the `Stop` hook and
    /// the transcript record cross.
    pub turn_tail: tui::TurnTail,
    /// Tools already answered for in this turn, by the command they name.
    /// Codex fires `PreToolUse` and then `PermissionRequest` for the same
    /// call, and one tool must not cost the reader two cards.
    pub answered: HashMap<String, bool>,
    /// What the pane is running, for the terminal view's header and for a
    /// window that has to be told about a pane it did not see start.
    pub command: String,
    /// What this launch's hooks have to prove to be heard: the secret it was
    /// given, and where its transcript is allowed to be.
    pub origin: Origin,
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
    status: Arc<crate::status::StatusState>,
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

/// How long a restart waits for the outgoing CLI to let go of its conversation.
const RESTART_WAIT: std::time::Duration = std::time::Duration::from_secs(6);

fn key_of(session_id: &str, tab_id: &str) -> String {
    format!("{session_id}/{tab_id}")
}

/// One value per key, created under the lock.
///
/// The whole check-and-create is held, not just the lookup. A tab runtime built
/// twice hands each caller its own mutex, and everything that runtime guards —
/// above all the check that stops a tab starting a second CLI — is then
/// guarding nothing: both callers pass it and the tab spawns two agents on the
/// same conversation, of which the second is refused and the first is lost.
fn one_per_key<V: Clone>(map: &Mutex<HashMap<String, V>>, key: &str, make: impl FnOnce() -> Result<V>) -> Result<V> {
    let mut map = map.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = map.get(key) {
        return Ok(v.clone());
    }
    let v = make()?;
    map.insert(key.to_string(), v.clone());
    Ok(v)
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
    pub fn new(
        app: AppHandle,
        host: Arc<Host>,
        terminals: Arc<pty::Terminals>,
        codex_models: Arc<codex::models::Cache>,
        status: Arc<crate::status::StatusState>,
    ) -> Self {
        Self {
            app,
            host,
            terminals,
            codex_models,
            status,
            tabs: Arc::new(Mutex::new(HashMap::new())),
            writers: Arc::new(Mutex::new(HashMap::new())),
            starts: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    fn runtime(&self, session_id: &str, tab_id: &str) -> Result<Arc<Mutex<TabRuntime>>> {
        let key = key_of(session_id, tab_id);
        one_per_key(&self.tabs, &key, || {
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
            Ok(rt)
        })
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

    fn running_agents(&self) -> std::collections::HashSet<String> {
        self.tabs
            .lock()
            .unwrap()
            .values()
            .filter_map(|runtime| {
                let runtime = runtime.lock().unwrap();
                let Engine::Cli(cli) = &runtime.engine else { return None };
                self.terminals.is_running(&cli.pane_id).then(|| match cli.harness {
                    CliKind::Claude => "claude".to_string(),
                    CliKind::Codex => "codex".to_string(),
                })
            })
            .collect()
    }

    pub fn usage_snapshot(&self) -> crate::status::usage::UsageSnapshot {
        self.status.usage.snapshot(&self.running_agents())
    }

    fn emit_usage(&self) {
        let _ = self.app.emit(crate::status::usage::EVENT, self.usage_snapshot());
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
        let pane = rt.and_then(|rt| {
            let mut rt = rt.lock().unwrap();
            rt.child = None;
            rt.child_pid = None;
            self.release_cli(&mut rt)
        });
        // The CLI holds its conversation until it is gone, and Claude Code
        // ignores a polite signal, so a prompt sent straight after Stop would
        // otherwise find the session still taken.
        if let Some(pane) = pane {
            self.terminals.kill_and_wait(&pane, RESTART_WAIT);
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
        let turn_open = rt.turn_open;
        let mut restart = false;
        match &mut rt.engine {
            // Claude's own `/model` takes the change live. Codex's `/model`
            // opens a picker rather than taking an argument, so its tab is
            // restarted on the same conversation instead.
            Engine::Cli(p) if p.harness == CliKind::Claude => {
                let pane = p.pane_id.clone();
                self.type_command(&rt_arc, &pane, format!("/model {model}"));
            }
            Engine::Cli(p) => {
                if turn_open {
                    p.restart_when_idle = true;
                } else {
                    restart = true;
                }
            }
            Engine::Acp(a) => {
                let actions = a.set_model(model);
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => o.model = Some(model.into()),
            _ => {}
        }
        self.publish(&mut rt, Payload::SettingsChanged { model: Some(model.into()), effort: None, permission_mode: None }, None);
        drop(rt);
        if restart {
            self.restart_for_settings(session_id, tab_id)?;
        }
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
            // Neither TUI has a command for this — Claude cycles modes on a
            // key with no way to read the result back, Codex fixes its
            // approval policy and sandbox at launch — so the change means
            // replacing the process.
            Engine::Cli(p) => {
                if turn_open {
                    p.restart_when_idle = true;
                } else {
                    restart = true;
                }
            }
            Engine::Acp(a) => {
                let actions = a.set_mode(mode);
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => o.mode = mode.into(),
            _ => {}
        }
        if turn_open && matches!(rt.engine, Engine::Cli(_)) {
            self.publish(&mut rt, Payload::Status { text: "Permission mode applies after this turn.".into() }, None);
        }
        self.publish(&mut rt, Payload::SettingsChanged { model: None, effort: None, permission_mode: Some(mode.into()) }, None);
        drop(rt);
        if restart {
            self.restart_for_settings(session_id, tab_id)?;
        }
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
                    let pane = p.pane_id.clone();
                    self.type_command(&rt_arc, &pane, format!("/effort {e}"));
                }
            }
            Engine::Cli(p) => {
                if turn_open {
                    p.restart_when_idle = true;
                } else {
                    restart = true;
                }
            }
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
        drop(rt);
        if restart {
            self.restart_for_settings(session_id, tab_id)?;
        }
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
    ///
    /// The pane is announced either way. A window that opens after the CLI
    /// started — the app restarting into a session that was already running —
    /// never saw the event, and would show a terminal view with nothing in it.
    pub fn ensure_started(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        if pty_first(&tab.harness).is_none() {
            return Ok(());
        }
        let mut rt = rt_arc.lock().unwrap();
        if !self.start_cli(&mut rt, &rt_arc, &entry, &tab)? {
            self.announce_pane(&rt);
        }
        Ok(())
    }

    /// The pane a tab's CLI is running in, for a window that has to ask
    /// because it was not listening when the pane opened.
    pub fn pane_of(&self, session_id: &str, tab_id: &str) -> Option<TabPtyEvent> {
        let rt_arc = self.runtime(session_id, tab_id).ok()?;
        let rt = rt_arc.lock().unwrap();
        Self::pane_event(&rt)
    }

    /// The CLI process in a PTY pane exited. Hooks normally close the turn
    /// first; when they do not, the process death is a failed automation run.
    pub fn pane_exited(&self, pane_id: &str, code: Option<i32>) {
        let Some(tab_id) = pane_id.strip_prefix("tab:") else { return };
        let Some(entry) = index::load().ok().and_then(|sessions| sessions.into_iter().find(|session| session.tab(tab_id).is_some())) else { return };
        let Ok(rt_arc) = self.runtime(&entry.id, tab_id) else { return };
        let mut rt = rt_arc.lock().unwrap();
        let turn_was_open = rt.turn_open;
        if turn_was_open {
            self.close_open_turn(&mut rt, TurnStatus::Error, None);
        }
        self.set_status(&mut rt, TabStatus::Idle);
        drop(rt);
        if turn_was_open {
            let detail = code.map(|value| format!(" with exit code {value}")).unwrap_or_else(|| " from a signal".into());
            crate::automations::fail_from_hook(&self.app, &entry.id, tab_id, &format!("The agent process exited{detail} before the automation turn completed."));
        }
    }

    fn pane_event(rt: &TabRuntime) -> Option<TabPtyEvent> {
        let Engine::Cli(p) = &rt.engine else { return None };
        Some(TabPtyEvent {
            session_id: rt.session_id.clone(),
            tab_id: rt.tab_id.clone(),
            pane_id: p.pane_id.clone(),
            command: p.command.clone(),
            harness: rt.harness.clone(),
        })
    }

    fn announce_pane(&self, rt: &TabRuntime) {
        if let Some(ev) = Self::pane_event(rt) {
            let _ = self.app.emit("tab_pty", ev);
        }
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
        self.terminals.kill_and_wait(&pane, RESTART_WAIT);

        let exe = std::env::current_exe().context("locate this binary for the CLI's hooks")?;
        let mut env = vec![
            ("RACCOON_SESSION_ID".to_string(), rt.session_id.clone()),
            ("RACCOON_TAB_ID".to_string(), rt.tab_id.clone()),
        ];
        // A fresh secret per launch, per tab: the socket path is inherited by
        // every process the agent starts, so what keeps one tab's hooks from
        // speaking for another is that only this CLI was given this token.
        let token = crate::hooks::mint_token();
        match crate::hooks::socket_path() {
            Ok(p) => {
                env.push((crate::hooks::SOCKET_ENV.to_string(), p.to_string_lossy().into_owned()));
                env.push((crate::hooks::TOKEN_ENV.to_string(), token.clone()));
            }
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
            restart_when_idle: false,
            // Claude Code runs its SessionStart hook the moment it is up;
            // Codex has no session, and so no hook, until a prompt makes one.
            ready: Arc::new(tui::Ready::new(kind == CliKind::Claude)),
            tail: tail.clone(),
            echoed: Default::default(),
            decisions: HashMap::new(),
            turn_tail: Default::default(),
            answered: HashMap::new(),
            command: launch.command,
            origin: Origin { token, transcript_root: launch.transcript_root },
        });
        rt.turn_open = false;
        self.announce_pane(rt);
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
        // The CLI keeps every transcript for this checkout here, and the file
        // it reports at `SessionStart` has to be one of them.
        let transcript_root = path.parent().context("the transcript path has no directory")?.to_path_buf();
        // A fork is handed a copy of the whole parent conversation, written
        // into its new file when the first turn lands. The app already has all
        // of it, and the copy keeps each record's original uuid, so those are
        // the ones to drop.
        let carried = fork_from.as_deref().and_then(|parent| claude::transcript::record_uuids(&entry.cwd, parent)).unwrap_or_default();
        Ok(CliLaunch {
            command,
            tail: tui::Tail::opening(path, claude::transcript::decode_line, carried),
            minted: (!resume).then_some(provider_id),
            transcript_root,
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

        let codex::home::Prepared { home, hooks_live } = codex::home::prepare(&entry.cwd, exe).context("prepare the Codex home")?;
        env.push(("CODEX_HOME".to_string(), home.to_string_lossy().into_owned()));
        if !hooks_live {
            // The hooks are what say a turn began, needs a decision, or ended.
            // Without them the chat is only the rollout, which never says the
            // turn is over — so say so rather than leave a turn spinning.
            let text = "Codex could not install its hooks here, so this tab shows the conversation but not its progress. The terminal view is unaffected.".to_string();
            self.publish(rt, Payload::Status { text }, None);
        }

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
                Some(path) => tui::Tail::opening(path, codex::rollout::decode_line, Default::default()),
                None => tui::Tail::unknown(codex::rollout::decode_line),
            },
            minted: None,
            // Codex names its own rollout, and only ever under the home
            // Raccoon built for it.
            transcript_root: home.join("sessions"),
        })
    }

    /// Restart the CLI so it reads a setting it only takes at startup: the
    /// permission mode for either CLI, and the model and effort for Codex,
    /// which has no command for them. The pane is kept and the conversation
    /// resumes, so what the reader sees is the CLI redrawing, not a new tab.
    ///
    /// The old process has to be *gone*, not merely signalled: it holds the
    /// conversation until it exits, and the replacement is refused a session
    /// another process still has.
    fn restart_for_settings(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        let pane = Self::pane_id(tab_id);
        {
            let mut rt = rt_arc.lock().unwrap();
            if let Engine::Cli(p) = &mut rt.engine {
                p.restart_when_idle = false;
            }
            self.release_cli(&mut rt);
        }
        // Outside the lock: this waits on another process.
        self.terminals.kill_and_wait(&pane, RESTART_WAIT);
        let mut rt = rt_arc.lock().unwrap();
        self.start_cli(&mut rt, &rt_arc, &entry, &tab)?;
        Ok(())
    }

    /// Let go of the tab's CLI, keeping the conversation so the next prompt
    /// resumes. Returns the pane the caller must kill — outside the tab lock,
    /// because waiting for the process to go is a wait on another process.
    fn release_cli(&self, rt: &mut TabRuntime) -> Option<String> {
        let Engine::Cli(p) = &rt.engine else { return None };
        let pane = p.pane_id.clone();
        rt.engine = Engine::None;
        rt.turn_open = false;
        self.set_status(rt, TabStatus::Idle);
        Some(pane)
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
            if let (Payload::AssistantText { text, .. }, Engine::Cli(p)) = (&payload, &mut rt.engine) {
                if !p.turn_tail.observe(text) {
                    continue; // the app already said this for a Stop hook
                }
            }
            if matches!(payload, Payload::UserMessage { .. }) {
                rt.turn_open = true;
                if let Engine::Cli(p) = &mut rt.engine {
                    p.turn_tail.opened();
                }
                self.set_status(&mut rt, TabStatus::InProgress);
            }
            if payload.is_turn_boundary() {
                if let Engine::Cli(p) = &mut rt.engine {
                    // The CLI's own hook may have closed this turn already.
                    if !p.turn_tail.closing() {
                        continue;
                    }
                }
            }
            self.apply(&mut rt, payload, None);
        }
    }

    /// Wait, briefly, for the transcript to deliver the reply the `Stop` hook
    /// is already holding. If it never comes, publish it here and mark its
    /// record to be dropped when it lands, so it is drawn exactly once.
    fn settle_reply(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>, want: Option<&str>) {
        let Some(want) = want.map(str::trim).filter(|w| !w.is_empty()) else { return };
        let saw = |rt: &TabRuntime| matches!(&rt.engine, Engine::Cli(p) if p.turn_tail.saw(want));
        let deadline = Instant::now() + tui::STOP_SETTLE;
        loop {
            if saw(&rt_arc.lock().unwrap()) {
                return;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(tui::POLL_INTERVAL);
            self.pump(rt_arc, tail);
        }
        let mut rt = rt_arc.lock().unwrap();
        // The poll thread may have landed it in the moment since the last look.
        if saw(&rt) {
            return;
        }
        let Engine::Cli(p) = &mut rt.engine else { return };
        p.turn_tail.anticipate(want);
        self.apply(&mut rt, Payload::AssistantText { block: None, text: want.to_string() }, None);
    }

    /// Publish the turn's boundary, once. Both guards matter: `turn_open` stops
    /// a close with no turn behind it, and the latch stops the second of the
    /// two closers that race for a PTY-first tab.
    fn close_open_turn(&self, rt: &mut TabRuntime, status: TurnStatus, final_text: Option<String>) {
        if !rt.turn_open {
            return;
        }
        if let Engine::Cli(p) = &mut rt.engine {
            if !p.turn_tail.closing() {
                return;
            }
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
        self.start_cli(rt, rt_arc, entry, tab)?;
        let (pane, ready) = match &rt.engine {
            Engine::Cli(p) => (p.pane_id.clone(), p.ready.clone()),
            _ => bail!("the agent is not running"),
        };
        let queued = rt.turn_open;
        let baseline = if queued { None } else { git::snapshot_tree(Path::new(&entry.cwd)).ok() };
        let paths: Vec<String> = images.iter().map(|i| i.url.clone()).collect();
        if !queued {
            if let Engine::Cli(p) = &mut rt.engine {
                p.echoed.push_back(text.clone());
                p.turn_tail.opened();
            }
        }
        let ev = self.publish(rt, Payload::UserMessage { text: text.clone(), images, baseline, queued, cwd: Some(entry.cwd.clone()) }, None);
        self.type_prompt(rt_arc, &pane, text, paths, Some(ready));
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
    fn type_prompt(&self, rt_arc: &Arc<Mutex<TabRuntime>>, pane: &str, text: String, attachments: Vec<String>, ready: Option<Arc<tui::Ready>>) {
        let lock = self.writers.lock().unwrap().entry(pane.to_string()).or_default().clone();
        let terminals = self.terminals.clone();
        let manager = self.clone();
        let rt_arc = rt_arc.clone();
        let pane = pane.to_string();
        let _ = std::thread::Builder::new().name("cli-input".into()).spawn(move || {
            let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ready) = ready {
                if !manager.wait_ready(&pane, &ready) {
                    // Both signals failed. Typing anyway may lose the prompt to
                    // a TUI that is not listening, but dropping it silently is
                    // worse: the reader would watch a message they sent never
                    // appear anywhere at all.
                    log::warn!("[{pane}] never reported ready; typing the prompt regardless");
                    let mut rt = rt_arc.lock().unwrap();
                    manager.apply(&mut rt, Payload::Status { text: "The agent was slow to start; check that your message arrived.".into() }, None);
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

    /// Wait until the pane's CLI is listening. `true` when it said so — or looked
    /// like it — and `false` when neither signal came in time.
    ///
    /// Claude Code's `SessionStart` hook is the deterministic signal: it runs
    /// once the session is up, whether it started fresh or resumed. Quiet output
    /// is only the fallback there — a TUI drawing a spinner never goes quiet,
    /// which is how a prompt sent to a resumed tab used to be dropped after the
    /// wait timed out.
    ///
    /// Codex has no equivalent: probed fresh and resumed with no prompt sent, it
    /// runs no hook at all until a prompt creates its session, which is the very
    /// thing being waited for. Its tab reads the screen, and that is not a
    /// failure, so it is not logged as one.
    fn wait_ready(&self, pane: &str, ready: &tui::Ready) -> bool {
        let deadline = Instant::now() + tui::READY_TIMEOUT;
        loop {
            if ready.settled() {
                return true;
            }
            if !self.terminals.is_running(pane) {
                log::warn!("[{pane}] exited before it was ready");
                return false;
            }
            if Instant::now() >= deadline {
                return false;
            }
            if self.terminals.quiet_for(pane).is_some_and(|q| q >= tui::READY_QUIET) {
                if ready.announces_start() {
                    log::warn!("[{pane}] never ran its SessionStart hook; falling back to quiet output");
                }
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// A slash command the CLI runs itself (`/model`, `/effort`).
    fn type_command(&self, rt_arc: &Arc<Mutex<TabRuntime>>, pane: &str, command: String) {
        self.type_prompt(rt_arc, pane, command, Vec::new(), None);
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
        let (kind, tail, asks_every_tool, origin) = {
            let rt = rt_arc.lock().unwrap();
            match &rt.engine {
                Engine::Cli(p) => (p.harness, p.tail.clone(), p.harness == CliKind::Codex && codex::asks_every_tool(&p.mode), p.origin.clone()),
                // A hook from a CLI this app did not start, or from one whose
                // tab has moved on: nothing to say, and nothing to block.
                _ => return HookReply::default(),
            }
        };
        // The socket is owner-only, but so is everything else this user runs,
        // including whatever the agent itself starts. A frame that cannot
        // show this launch's token did not come from this tab's CLI, and
        // answering it would let one tab decide another tab's permissions.
        if !origin.accepts(&frame) {
            log::warn!("hook {} for {}/{} refused: not this tab's token", frame.event, frame.session, frame.tab);
            return HookReply::default();
        }
        if frame.event == "StatusLine" {
            if kind == CliKind::Claude && self.status.usage.ingest_claude(&frame.tab, &frame.payload) {
                self.emit_usage();
            }
            return HookReply::default();
        }
        // Claude's transcript path is a guess made before the CLI ran and
        // Codex's is not knowable at all until now; either way the hook
        // carries the file it actually opened — but only a file this CLI
        // could have opened, so a frame cannot aim the tail at, say, the
        // reader's private notes and have the chat read them out.
        match (frame.payload["transcript_path"].as_str(), origin.transcript(&frame)) {
            (_, Some(path)) => tail.retarget(path),
            (Some(named), None) => log::warn!(
                "hook {} for {}/{} named a transcript outside {}: {named}",
                frame.event,
                frame.session,
                frame.tab,
                origin.transcript_root.display()
            ),
            (None, None) => {}
        }
        self.pump(&rt_arc, &tail);

        match frame.event.as_str() {
            // The CLI's session is up; the composer may stop waiting. Codex
            // also mints its own conversation id, so this is where the app
            // learns which one to resume next time.
            "SessionStart" => {
                if let Engine::Cli(p) = &rt_arc.lock().unwrap().engine {
                    p.ready.mark();
                }
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
                drop(rt);
                if frame.event == "UserPromptSubmit" {
                    crate::automations::mark_running_from_hook(&self.app, &frame.session, &frame.tab);
                }
            }
            // The CLI is asking in its own TUI, which means our permission
            // hook did not answer in time. The reader has to go and look.
            "Notification" if frame.payload["notification_type"] == "permission_prompt" => {
                let mut rt = rt_arc.lock().unwrap();
                self.set_status(&mut rt, TabStatus::Waiting);
            }
            "Stop" => {
                let final_text = frame.payload["last_assistant_message"].as_str().map(String::from);
                // The hook fires the moment the model stops; the record of what
                // it said is a file write the tailer has yet to see. Closing
                // the turn first would leave that record outside it, drawn a
                // second time under the "Worked for Ns" line.
                self.settle_reply(&rt_arc, &tail, final_text.as_deref());
                let mut rt = rt_arc.lock().unwrap();
                rt.last_activity = Instant::now();
                self.forget_tool_answers(&mut rt);
                self.close_open_turn(&mut rt, TurnStatus::Ok, final_text);
                drop(rt);
                crate::automations::complete_from_hook(
                    &self.app,
                    &frame.session,
                    &frame.tab,
                    frame.payload["last_assistant_message"].as_str().map(String::from),
                );
            }
            // Codex only: the reader pressed Escape in the TUI.
            "Interrupt" => {
                let mut rt = rt_arc.lock().unwrap();
                self.forget_tool_answers(&mut rt);
                self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                drop(rt);
                crate::automations::fail_from_hook(&self.app, &frame.session, &frame.tab, "The automation turn was interrupted.");
            }
            "SessionEnd" => {
                let mut rt = rt_arc.lock().unwrap();
                let turn_was_open = rt.turn_open;
                self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                self.set_status(&mut rt, TabStatus::Idle);
                drop(rt);
                if turn_was_open {
                    crate::automations::fail_from_hook(
                        &self.app,
                        &frame.session,
                        &frame.tab,
                        "The agent session ended before the automation turn completed.",
                    );
                }
            }
            _ => {}
        }
        self.restart_if_due(&rt_arc, &frame.session, &frame.tab);
        HookReply::default()
    }

    /// A setting the CLI only reads at startup changed mid-turn: the restart
    /// it needs waits here, until the turn it would have interrupted is over.
    /// Off this thread, so the hook's reply reaches the CLI before the CLI is
    /// replaced.
    fn restart_if_due(&self, rt_arc: &Arc<Mutex<TabRuntime>>, session_id: &str, tab_id: &str) {
        {
            let rt = rt_arc.lock().unwrap();
            let due = matches!(&rt.engine, Engine::Cli(p) if p.restart_when_idle) && !rt.turn_open;
            if !due {
                return;
            }
        }
        let (manager, session, tab) = (self.clone(), session_id.to_string(), tab_id.to_string());
        std::thread::spawn(move || {
            if let Err(e) = manager.restart_for_settings(&session, &tab) {
                log::warn!("restart {session}/{tab}: {e:#}");
            }
        });
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
    /// terminal view is a view flag, not a hand-off. Only the hidden
    /// harnesses reach this, which is why it outlives them being offered.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    /// Two tab views mounting at once — React runs a mount effect twice in
    /// development — used to build a runtime each, so each held its own lock
    /// and both got past the "already running?" check into a spawn. A CLI
    /// refuses the second process a conversation the first already has, and
    /// the tab was left pointing at whichever spawn won.
    #[test]
    fn concurrent_callers_share_one_runtime_and_one_creation() {
        let map: Arc<Mutex<HashMap<String, Arc<usize>>>> = Arc::new(Mutex::new(HashMap::new()));
        let made = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));

        let got: Vec<Arc<usize>> = (0..8)
            .map(|_| {
                let (map, made, barrier) = (map.clone(), made.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    one_per_key(&map, "s/t", || {
                        made.fetch_add(1, Ordering::SeqCst);
                        // Creation reads the index off disk, so the window is
                        // real rather than theoretical.
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        Ok(Arc::new(7))
                    })
                    .unwrap()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();

        assert_eq!(made.load(Ordering::SeqCst), 1, "the runtime is built once");
        for v in &got {
            assert!(Arc::ptr_eq(v, &got[0]), "every caller gets the same runtime");
        }
        assert_eq!(map.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_failed_creation_is_not_remembered() {
        let map: Arc<Mutex<HashMap<String, Arc<usize>>>> = Arc::new(Mutex::new(HashMap::new()));
        assert!(one_per_key(&map, "s/t", || Err(anyhow!("no such tab"))).is_err());
        assert!(map.lock().unwrap().is_empty());
        assert_eq!(*one_per_key(&map, "s/t", || Ok(Arc::new(3))).unwrap(), 3);
    }

    #[test]
    fn a_decision_is_printed_in_the_shape_the_hook_that_asked_expects() {
        let out = |kind, event, d| reply_for(kind, event, d).output.unwrap();

        // Claude: one event, and an allow can carry a rule or an answer.
        let allow = out(CliKind::Claude, "PermissionRequest", Decision::Allow);
        assert_eq!(allow["hookSpecificOutput"]["decision"]["behavior"], "allow");
        let always = out(CliKind::Claude, "PermissionRequest", Decision::AllowWith(json!({"type": "addRules"})));
        assert_eq!(always["hookSpecificOutput"]["decision"]["updatedPermissions"][0]["type"], "addRules");
        let answered = out(CliKind::Claude, "PermissionRequest", Decision::Answers(json!({"answers": {"q": "a"}})));
        assert_eq!(answered["hookSpecificOutput"]["decision"]["updatedInput"]["answers"]["q"], "a");

        // Codex: two events, two shapes, and neither takes anything extra —
        // it fails the hook closed if updatedInput is so much as present.
        let gate = out(CliKind::Codex, "PreToolUse", Decision::Deny);
        assert_eq!(gate["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(gate["hookSpecificOutput"]["permissionDecision"], "deny");
        let ask = out(CliKind::Codex, "PermissionRequest", Decision::Allow);
        assert_eq!(ask["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(ask["hookSpecificOutput"]["decision"]["behavior"], "allow");
        // A suggestion has nowhere to go in a Codex reply, and is dropped
        // rather than smuggled into a field that would fail closed.
        let odd = out(CliKind::Codex, "PermissionRequest", Decision::AllowWith(json!({"type": "addRules"})));
        assert_eq!(odd["hookSpecificOutput"]["decision"], json!({"behavior": "allow"}));
    }

    #[test]
    fn one_tool_is_the_same_tool_whichever_hook_asks_about_it() {
        // Codex adds its justification to the input when it escalates; the
        // command is what says these are one call, so the reader is asked once.
        let pre = tool_key("Bash", &json!({"command": "rm -rf build"}));
        let request = tool_key("Bash", &json!({"command": "rm -rf build", "description": "Delete the build tree?"}));
        assert_eq!(pre, request);
        assert_ne!(pre, tool_key("Bash", &json!({"command": "rm -rf dist"})));
        assert_ne!(pre, tool_key("Read", &json!({"command": "rm -rf build"})));
    }

    #[test]
    fn only_the_tabs_that_are_their_cli_are_pty_first() {
        assert_eq!(pty_first("claude"), Some(CliKind::Claude));
        assert_eq!(pty_first("codex"), Some(CliKind::Codex));
        assert_eq!(pty_first("cursor"), None);
        assert_eq!(pty_first("opencode"), None);
    }
}
