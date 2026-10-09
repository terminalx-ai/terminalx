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
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::events::*;
use crate::recovery::{self, RecoveryKind};
use crate::harness::host::{Host, LiveChild, Sink, SpawnSpec};
use crate::harness::{acp, claude, codex, opencode, tui, Action, CliKind, HarnessId};
use crate::hooks::{HookFrame, HookReply, Origin};
use crate::store::index::{self, TabEntry, TabStatus};
use crate::sink::{EventSink, SessionObserver};
use crate::{git, pty, store};

#[derive(Clone)]
pub struct PendingAsk {
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: Value,
    /// Suggestion payloads keyed by option id ("suggest:N").
    pub suggestions: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub session_id: String,
    pub tab_id: String,
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTab {
    pub session_id: String,
    pub tab_id: String,
    pub harness: String,
    pub status: TabStatus,
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

/// Own the receiver so a timed-out hook stops accepting answers before it
/// waits to reacquire the runtime lock. Only the returned decision resumes work.
fn wait_for_decision(rx: std::sync::mpsc::Receiver<Decision>, wait: std::time::Duration) -> Option<Decision> {
    rx.recv_timeout(wait).ok()
}

/// What a PTY-first tab needs to start: the line the pane runs, the
/// transcript to follow, and the conversation id if the app minted one.
struct CliLaunch {
    command: String,
    tail: tui::Tail,
    minted: Option<String>,
    /// The only directory this launch's hooks may point the tail into.
    transcript_root: PathBuf,
    /// Claude: the conversation's own file, which may be in another folder.
    conversation: Option<crate::hooks::ConversationFile>,
}

/// How the wait for a pane's CLI to listen ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Readiness {
    Cancelled,
    /// It said so, or went quiet on something that is not a known dialog.
    Ready,
    /// Neither signal came in time, or the CLI exited.
    TimedOut,
    /// It is sitting on a first-run screen; the message says which.
    Blocked(&'static str),
}

type DeliveryReceipt = std::sync::mpsc::Sender<std::result::Result<(), String>>;

/// A composer prompt waiting for the CLI transcript to echo it. Both CLIs
/// add an `[Image #N]` label per pasted image to the echoed text, so the
/// attachment count is part of the identity even though the composer already
/// published the archived images. Codex writes the labels with a space before
/// the text; Claude Code writes them with nothing in between.
struct ComposerEcho {
    text: String,
    image_count: usize,
    sent_at: Instant,
    receipt: Option<DeliveryReceipt>,
    /// Confirmation is armed only after Enter was written successfully, not
    /// while the prompt is waiting for the CLI to become ready.
    submitted: bool,
    /// Sent while a turn was running, so the CLI holds it until it has a
    /// use for it. Its echo may be a long time coming, and may arrive after
    /// the turn it was queued behind has ended — as the prompt of the next.
    queued: bool,
    /// A command the app typed for itself (`/model`), which the composer
    /// never published. The CLI records the name with or without what
    /// followed it; either is this command, and neither is the reader's.
    command: bool,
    /// The `seq` the composer's own `user_message` was published under.
    seq: u64,
}

/// A composer prompt the CLI's record was matched to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Echoed {
    queued: bool,
    seq: u64,
}

/// How long a composer prompt waits for its echo once no turn is running.
/// Longer than the ready wait, so a slow start is not mistaken for a miss.
const COMPOSER_ECHO_TTL: std::time::Duration = std::time::Duration::from_secs(120);
/// How long a queued prompt waits once the turn it was queued behind is
/// over. A CLI that held it that long takes it at once, so this is short: a
/// queue the CLI discarded must not go on swallowing the same words typed
/// into the terminal.
const QUEUED_ECHO_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

impl ComposerEcho {
    fn new(text: String, image_count: usize) -> Self {
        Self { text, image_count, sent_at: Instant::now(), receipt: None, submitted: false, queued: false, command: false, seq: 0 }
    }

    fn matches(&self, echoed: &str) -> bool {
        let (labels, rest) = strip_image_labels(echoed);
        let (rest, text) = (rest.trim(), self.text.trim());
        if labels != self.image_count {
            return false;
        }
        if rest == text || (self.command && text.split_whitespace().next() == Some(rest)) {
            return true;
        }
        // The CLI may reflow a paste or enclose it (or its chunks) in these
        // tags. Compare every word: a shared prefix/suffix alone could swallow
        // a different prompt typed in the terminal.
        static PASTED: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"(?s)<pasted_content(?:\s+[^>]*)?>(.*?)</pasted_content(?:\s+[^>]*)?>").unwrap()
        });
        rest.split_whitespace().eq(text.split_whitespace())
            || PASTED.replace_all(rest, "$1").split_whitespace().eq(text.split_whitespace())
    }

    fn confirm_delivery(&mut self) -> bool {
        self.submitted && self.receipt.take().is_some_and(|receipt| receipt.send(Ok(())).is_ok())
    }

    fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.sent_at) > if self.queued { QUEUED_ECHO_GRACE } else { COMPOSER_ECHO_TTL }
    }
}

/// Peel the run of `[Image #1] [Image #2] …` labels off the front of an echoed
/// prompt: how many there were, and the text after them. The labels have to be
/// numbered in order from one; anything else is prose and stays put.
fn strip_image_labels(mut text: &str) -> (usize, &str) {
    let mut count = 0;
    loop {
        let candidate = text.trim_start();
        let Some(after_open) = candidate.strip_prefix("[Image #") else { break };
        let digits = after_open.len() - after_open.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        let Some(rest) = after_open[digits..].strip_prefix(']') else { break };
        if after_open[..digits].parse::<usize>().ok() != Some(count + 1) {
            break;
        }
        count += 1;
        text = rest;
    }
    (count, text)
}

/// The composer's own record of a prompt, and what the CLI's record of the
/// same prompt will look like. A queued prompt is echoed too: Codex writes a
/// steer into the rollout as it takes it and Claude Code records it as a
/// queued command, and either would otherwise be the same message twice.
fn cli_composer_message(prompt: &PromptText, images: Vec<ImageRef>, baseline: Option<String>, queued: bool, cwd: &str) -> (Payload, ComposerEcho) {
    let echo = ComposerEcho { queued, ..ComposerEcho::new(prompt.agent.clone(), images.len()) };
    let payload = Payload::UserMessage { author: prompt.author.clone(), text: prompt.display.clone(), images, baseline, queued, cwd: Some(cwd.to_string()) };
    (payload, echo)
}

/// Whether `payload` is the transcript's copy of a prompt the composer already
/// published. The transcript replays user messages in the order they were
/// sent, so a match further back in the queue means the entries ahead of it
/// were missed: they are dropped with it rather than left to shift every later
/// comparison by one.
///
/// `Some` is a match, and says whether the prompt had been queued. A user
/// message with no match is one the composer never sent: it was typed into
/// the terminal, and the transcript's record is the only one there is.
fn consume_composer_echo(pending: &mut std::collections::VecDeque<ComposerEcho>, payload: &Payload) -> Option<Echoed> {
    let Payload::UserMessage { text, .. } = payload else { return None };
    let at = pending.iter().position(|prompt| (prompt.receipt.is_none() || prompt.submitted) && prompt.matches(text))?;
    if at > 0 {
        log::warn!("{at} composer prompt(s) never echoed by the transcript; dropping them");
    }
    pending[at].confirm_delivery();
    let echoed = Echoed { queued: pending[at].queued, seq: pending[at].seq };
    pending.drain(..=at);
    Some(echoed)
}

/// Forget prompts that have waited too long. A prompt the transcript never
/// echoes would otherwise sit at the head of the queue for the life of the
/// tab, and swallow the same words typed into the terminal later.
///
/// Nothing ages while a turn is running. The CLI may record a prompt long
/// after it was sent — a slow start, a queued prompt behind a long turn —
/// and dropping its echo early would draw that record as a second message.
/// The wait is counted from when the turn was last seen running.
fn expire_composer_echoes(pending: &mut std::collections::VecDeque<ComposerEcho>, turn_open: bool, now: Instant) {
    if turn_open {
        for prompt in pending.iter_mut() {
            prompt.sent_at = now;
        }
    }
    let before = pending.len();
    pending.retain(|prompt| !prompt.expired(now));
    if pending.len() < before {
        log::warn!("{} composer prompt(s) expired without an echo", before - pending.len());
    }
}

/// A PTY-first tab: the CLI in a pane, its transcript being followed, and the
/// permission frames its hooks have parked here waiting for an answer.
pub struct CliTab {
    /// Account/config identity captured before launch, used only for usage attribution.
    usage_account: Option<String>,
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
    echoed: std::collections::VecDeque<ComposerEcho>,
    /// The initial composer prompt, until the CLI confirms it through a
    /// transcript echo or turn activity. Startup readiness is not delivery.
    awaiting_delivery: Option<u64>,
    /// Hook threads parked on a decision, by request id.
    pub decisions: HashMap<String, std::sync::mpsc::Sender<Decision>>,
    /// Keeps the turn's reply from being drawn twice when the `Stop` hook and
    /// the transcript record cross.
    pub turn_tail: tui::TurnTail,
    /// What the transcript last said about the turn. Hooks close turns; this
    /// is what the session watcher goes on when they have gone quiet.
    pub transcript_turn: Option<tui::TurnMark>,
    /// Set when a turn closes before the transcript has recorded its end,
    /// which is the usual order: the `Stop` hook comes first. The next end
    /// the transcript records is then that turn's, and says nothing about
    /// whichever turn is open by the time it is read.
    pub transcript_end_owed: bool,
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
    pub recovery: Option<RecoveryKind>,
    /// When the session watcher raised a silence/delivery warning, if it did.
    /// A timeout the provider reported is a different fact and is not
    /// cleared by the terminal drawing again.
    pub stalled_at: Option<Instant>,
    pub stopping: bool,
    pub stop_in_flight: bool,
    pub stopping_pid: Option<u32>,
    pub log_path: std::path::PathBuf,
    /// Back-reference so work finished off-thread (an HTTP reply) can re-enter.
    pub me: std::sync::Weak<Mutex<TabRuntime>>,
}

impl TabRuntime {
    /// A turn opens, starting a fresh activity clock. Whatever the transcript
    /// last said was about a turn before this one, not this one's end.
    fn open_turn(&mut self) {
        self.turn_open = true;
        self.last_activity = Instant::now();
        if let Engine::Cli(p) = &mut self.engine {
            p.transcript_turn = None;
        }
    }

    fn key(&self) -> String {
        format!("{}/{}", self.session_id, self.tab_id)
    }
}

/// No child survives a restart: a tab persisted mid-turn or waiting is idle
/// now, whatever the index says.
pub fn idle_orphaned_tabs() {
    let _ = index::update(|sessions| {
        for s in sessions.iter_mut() {
            for t in s.tabs.iter_mut() {
                if matches!(t.status, TabStatus::InProgress | TabStatus::Waiting) {
                    t.status = TabStatus::Idle;
                }
            }
        }
        Ok(())
    });
}

#[derive(Clone)]
pub struct SessionManager {
    pub(crate) sharing: Arc<Mutex<crate::local_sharing::Sharing>>,
    sink: Arc<dyn EventSink>,
    observer: Arc<dyn SessionObserver>,
    host: Arc<Host>,
    terminals: Arc<pty::Terminals>,
    codex_models: Arc<codex::models::Cache>,
    status: Arc<crate::status::StatusState>,
    control: crate::hooks::ControlEndpoint,
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

struct PromptText {
    shared_connection: Option<crate::local_sharing::WritePermit>,
    author: Option<crate::local_sharing::Person>,
    agent: String,
    display: String,
}

#[derive(Default)]
struct PromptDelivery {
    ready: Option<Arc<tui::Ready>>,
    receipt: Option<(u64, DeliveryReceipt)>,
    shared: Option<(crate::local_sharing::WritePermit, String, String, u64)>,
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
/// Columns and rows every agent CLI starts at. A view that controls the
/// pane's size (the desktop's terminal view, a cloud tab's controller)
/// resizes it from here.
pub const CLI_PANE_SIZE: (u16, u16) = (120, 30);

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
    HookReply { output: Some(output), refused: None }
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
    /// The Codex model list this manager starts tabs against.
    pub fn codex_models(&self) -> Arc<codex::models::Cache> {
        self.codex_models.clone()
    }

    pub fn new(
        sink: Arc<dyn EventSink>,
        observer: Arc<dyn SessionObserver>,
        host: Arc<Host>,
        terminals: Arc<pty::Terminals>,
        codex_models: Arc<codex::models::Cache>,
        status: Arc<crate::status::StatusState>,
        control: crate::hooks::ControlEndpoint,
    ) -> Self {
        let manager = Self {
            sharing: Arc::new(Mutex::new(crate::local_sharing::Sharing::default())),
            sink,
            observer,
            host,
            terminals,
            codex_models,
            status,
            control,
            tabs: Arc::new(Mutex::new(HashMap::new())),
            writers: Arc::new(Mutex::new(HashMap::new())),
            starts: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        };
        let watcher = manager.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            watcher.watch_tabs(recovery::Patience::DEFAULT, Instant::now(), |pane| watcher.terminals.last_output(pane));
        });
        manager
    }

    /// One pass of the session watcher over every tab.
    ///
    /// The hooks and the transcript say what a turn is doing, and either can
    /// go missing: a single step may run for longer than the limit without an
    /// event, and a hook frame may never arrive at all. So before silence is
    /// called a stall the watcher looks at the two other things it can see.
    /// A transcript that recorded the end of the turn closes it, once the
    /// hooks have had their chance to; a pane that is still drawing is an
    /// agent still working. Only silence on every channel raises the warning,
    /// and a warning raised here is taken back when the pane draws again.
    ///
    /// The pass reads no clock of its own: `now` is the moment it judges
    /// from, and `drawn_at` says when a pane last drew. Everything it decides
    /// follows from those two and the tabs, so it can be checked at any
    /// moment one cares to name, without waiting for it.
    fn watch_tabs(&self, patience: recovery::Patience, now: Instant, drawn_at: impl Fn(&str) -> Option<Instant>) {
        let tabs: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        for rt_arc in tabs {
            let mut rt = rt_arc.lock().unwrap();
            let (pane, ended) = match &rt.engine {
                Engine::Cli(p) => (Some(p.pane_id.clone()), p.transcript_turn == Some(tui::TurnMark::Ended)),
                _ => (None, false),
            };
            let silent = now.saturating_duration_since(rt.last_activity);
            if rt.turn_open && ended && silent >= patience.settle {
                let final_message = match &rt.engine {
                    Engine::Cli(p) => p.turn_tail.last_assistant_message().map(str::to_owned),
                    _ => None,
                };
                // Not `close_open_turn`: that one defers to the latch that
                // keeps two closers from racing, and a turn a hook opened
                // never reset it. Left to the latch, such a turn would not
                // close here, and skipping the rest of the pass for it would
                // leave the tab "Working" for good with no warning either.
                self.end_open_turn(&mut rt, TurnStatus::Ok, None);
                self.after_turn_completed(&rt_arc, rt, final_message);
                continue;
            }
            // Only a PTY-first tab has a pane; the other engines are judged
            // on their events alone, as before.
            let drawn = pane.and_then(|pane| drawn_at(&pane));
            if let Some(at) = rt.stalled_at {
                if drawn.is_some_and(|drawn| drawn > at) {
                    self.stall_disproved(&mut rt);
                }
                continue;
            }
            let quiet = drawn.map_or(silent, |drawn| now.saturating_duration_since(drawn).min(silent));
            if recovery::is_stale(rt.status == TabStatus::InProgress, quiet, patience) {
                let kind = if matches!(&rt.engine, Engine::Cli(p) if p.awaiting_delivery.is_some()) {
                    RecoveryKind::DeliveryUnconfirmed
                } else {
                    RecoveryKind::Timeout
                };
                self.needs_recovery(&mut rt, kind);
                rt.stalled_at = Some(now);
            }
        }
    }

    /// Settle a PTY-first tab when the pane its CLI ran in exits.
    pub fn follow_pane_exits(&self) {
        let exited = self.clone();
        self.sink.listen(
            "pty_exit",
            Box::new(move |payload| {
                if let Ok(exit) = serde_json::from_str::<pty::PtyExit>(payload) {
                    exited.pane_exited(&exit.id, exit.code);
                }
            }),
        );
    }

    pub fn terminals(&self) -> &Arc<pty::Terminals> {
        &self.terminals
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
                recovery: None,
                stalled_at: None,
                stopping: false,
                stop_in_flight: false,
                stopping_pid: None,
                log_path,
                me: std::sync::Weak::new(),
            }));
            rt.lock().unwrap().me = Arc::downgrade(&rt);
            Ok(rt)
        })
    }

    /// Stamp, persist, emit. The one path every event takes.
    fn publish(&self, rt: &mut TabRuntime, mut payload: Payload, subagent: Option<SubagentRef>) -> AgentEvent {
        if matches!(&payload, Payload::Error { .. } | Payload::TurnCompleted { status: TurnStatus::Error, .. } | Payload::ApiRetry { .. } | Payload::RateLimited { .. } | Payload::PermissionDenied { .. })
            || matches!(&payload, Payload::ToolCallCompleted { result, .. } if result.is_error) {
            recovery::diagnose(&rt.log_path.with_extension("diagnostics.jsonl"), &payload);
            recovery::sanitize(&mut payload);
        }
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
        if ev.subagent.is_none() && matches!(&ev.payload, Payload::UserMessage { .. }) {
            match store::conversation_titles::name_tab(&ev.session_id, &ev.tab_id) {
                Ok(Some(session)) => self.sink.emit("session_updated", &session),
                Ok(None) => {}
                Err(error) => log::warn!("name conversation: {error:#}"),
            }
        }
        self.observer.agent_event(&ev);
        self.sink.emit("agent_event", &ev);
        ev
    }

    fn needs_recovery(&self, rt: &mut TabRuntime, kind: RecoveryKind) {
        rt.recovery = Some(kind);
        // Whatever is reported here replaces the watcher's guess, if there
        // was one; the watcher marks its own after this returns.
        rt.stalled_at = None;
        self.publish(rt, Payload::Recovery { kind: Some(kind) }, None);
        self.set_status(rt, TabStatus::Waiting);
    }

    /// Take back a stall the watcher called, now that something has shown
    /// the agent moving since. The warning goes from the log as well as the
    /// tab, so a reload does not bring it back. Nothing happens to a
    /// recovery the watcher did not raise.
    fn stall_disproved(&self, rt: &mut TabRuntime) {
        if rt.stalled_at.take().is_none() {
            return;
        }
        if rt.turn_open && rt.pending.is_empty() {
            self.set_status(rt, TabStatus::InProgress);
        } else if rt.recovery.take().is_some() {
            // Still waiting, on an ask or on nothing: only the warning goes.
            self.publish(rt, Payload::Recovery { kind: None }, None);
        }
    }

    /// Evidence from the CLI, not from writing bytes into its input. Keep
    /// startup recovery and continuation receipts separate: continuations
    /// require a matching echo or a submit hook after their Enter was written.
    fn delivery_confirmed(&self, rt: &mut TabRuntime) {
        if let Engine::Cli(p) = &mut rt.engine {
            p.awaiting_delivery = None;
            p.ready.mark();
        }
        self.stall_disproved(rt);
        if rt.recovery == Some(RecoveryKind::DeliveryUnconfirmed) {
            if rt.turn_open && rt.pending.is_empty() {
                self.set_status(rt, TabStatus::InProgress);
            } else {
                rt.recovery = None;
                self.publish(rt, Payload::Recovery { kind: None }, None);
            }
        }
    }

    fn set_status(&self, rt: &mut TabRuntime, status: TabStatus) {
        if status != TabStatus::Waiting {
            rt.stalled_at = None;
            if rt.recovery.take().is_some() {
                self.publish(rt, Payload::Recovery { kind: None }, None);
            }
        }
        // CLI work starts require a live hook (or a delivered permission
        // answer). Composer optimism and transcript hydration only affect UI.
        if !matches!(rt.engine, Engine::Cli(_)) || status != TabStatus::InProgress {
            self.record_activity(rt, status, store::activity::Source::Live);
        }
        self.set_display_status(rt, status);
    }

    fn record_activity(&self, rt: &TabRuntime, status: TabStatus, source: store::activity::Source) {
        match store::activity::transition(&rt.key(), status, source) {
            Ok(Some(total)) => {
                // #110's reminder can subscribe without scanning transcripts
                // or treating hydration/tab creation as fresh usage.
                self.sink.emit("agent_work_started", &total);
                self.observer.work_started(total as u64);
            }
            Ok(None) => {}
            Err(error) => log::error!("record app activity: {error:#}"),
        }
    }

    fn set_display_status(&self, rt: &mut TabRuntime, status: TabStatus) {
        if rt.status == status {
            return;
        }
        rt.status = status;
        self.observer.tab_status(rt.key(), status);
        self.sink.emit("tab_status", &TabStatusEvent { session_id: rt.session_id.clone(), tab_id: rt.tab_id.clone(), status });
        let (sid, tid) = (rt.session_id.clone(), rt.tab_id.clone());
        // Serialize status writes under the runtime lock so an old running
        // write cannot overwrite a newer waiting/idle state.
        let _ = index::update_tab(&sid, &tid, |t| {
            t.status = status;
            Ok(())
        });
    }

    /// The log, with any ask the running child is not actually waiting on
    /// retired as lapsed — only the child that asked can answer, and no child
    /// survives a restart, so a replayed card would have dead buttons.
    pub fn load_events(&self, session_id: &str, tab_id: &str) -> Result<Vec<AgentEvent>> {
        let path = store::log_path(session_id, tab_id)?;
        let mut events: Vec<AgentEvent> = store::read_lines(&path)?;
        self.reconcile_lapsed_events(session_id, tab_id, &mut events)?;
        for event in &mut events { recovery::sanitize(&mut event.payload); }
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.status == TabStatus::Idle && !rt.turn_open && !rt.stopping {
            if let Some(kind) = recovery::from_history(&events) {
                self.needs_recovery(&mut rt, kind);
            }
        }
        Ok(events)
    }

    /// Retire permission cards found in a bounded transcript window when the
    /// process that asked is no longer parked on them. A backwards mobile
    /// tail can use this without loading the entire append-only log.
    pub fn reconcile_lapsed_events(&self, session_id: &str, tab_id: &str, events: &mut Vec<AgentEvent>) -> Result<()> {
        let mut open: Vec<(String, Option<String>)> = Vec::new();
        for ev in events.iter() {
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
        Ok(())
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

    /// Whether the tab has a turn open (sent and not yet settled).
    pub fn turn_open(&self, session_id: &str, tab_id: &str) -> bool {
        self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).is_some_and(|runtime| runtime.lock().unwrap().turn_open)
    }

    /// Publish into a tab's transcript from outside its harness: the cloud
    /// runtime's own notes (a follow-up dropped by a stop, a turn that ended
    /// with the runtime).
    pub fn publish_external(&self, session_id: &str, tab_id: &str, payload: Payload) -> Result<AgentEvent> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        Ok(self.publish(&mut rt, payload, None))
    }

    pub fn is_running(&self, session_id: &str, tab_id: &str) -> bool {
        let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned();
        runtime.is_some_and(|runtime| {
            let runtime = runtime.lock().unwrap();
            runtime.child.is_some()
                || matches!(&runtime.engine, Engine::Cli(cli) if self.terminals.is_running(&cli.pane_id))
        })
    }

    pub fn running_tabs(&self) -> Vec<RunningTab> {
        let runtimes: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        runtimes
            .into_iter()
            .filter_map(|runtime| {
                let runtime = runtime.lock().unwrap();
                let running = runtime.child.is_some()
                    || matches!(&runtime.engine, Engine::Cli(cli) if self.terminals.is_running(&cli.pane_id));
                running.then(|| RunningTab {
                    session_id: runtime.session_id.clone(),
                    tab_id: runtime.tab_id.clone(),
                    harness: runtime.harness.clone(),
                    status: runtime.status,
                })
            })
            .collect()
    }

    /// Turns in progress and permission prompts waiting, counted without
    /// copying either (the cloud activity report polls this every second).
    pub fn turn_counts(&self) -> (usize, usize) {
        let runtimes: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        runtimes.into_iter().fold((0, 0), |(active, pending), runtime| {
            let runtime = runtime.lock().unwrap();
            let running = runtime.child.is_some()
                || matches!(&runtime.engine, Engine::Cli(cli) if self.terminals.is_running(&cli.pane_id));
            // An agent sitting at its sign-in screen is not working, whatever
            // its tab says (PRO-78): it must not hold off the idle suspend.
            let turn = running
                && runtime.status == TabStatus::InProgress
                && crate::cloud_grants::sign_in_required_for_launch(&runtime.harness, &runtime.key()).is_none();
            (active + usize::from(turn), pending + runtime.pending.len())
        })
    }

    pub fn usage_snapshot(&self) -> crate::status::usage::UsageSnapshot {
        self.status.usage.snapshot(&self.running_agents())
    }

    fn emit_usage(&self) {
        self.sink.emit(crate::status::usage::EVENT, &self.usage_snapshot());
    }

    pub fn pending_permissions(&self) -> Vec<PendingPermission> {
        let runtimes: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        let mut out = Vec::new();
        for runtime in runtimes {
            let runtime = runtime.lock().unwrap();
            for (request_id, pending) in &runtime.pending {
                let mut options = vec!["allow".to_string(), "deny".to_string()];
                options.extend((0..pending.suggestions.len()).map(|index| format!("suggest:{index}")));
                out.push(PendingPermission {
                    session_id: runtime.session_id.clone(),
                    tab_id: runtime.tab_id.clone(),
                    request_id: request_id.clone(),
                    tool_name: pending.tool_name.clone(),
                    input: pending.input.clone(),
                    options,
                });
            }
        }
        out.sort_by(|a, b| a.request_id.cmp(&b.request_id));
        out
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
        let mut env = vec![
            ("RACCOON_SESSION_ID".to_string(), rt.session_id.clone()),
            ("RACCOON_TAB_ID".to_string(), rt.tab_id.clone()),
            (crate::hooks::CONTROL_SOCKET_ENV.to_string(), self.control.socket.to_string_lossy().into_owned()),
            (crate::hooks::CONTROL_TOKEN_ENV.to_string(), self.control.token.clone()),
        ];
        // A cloud workspace's agent credentials (`cloud_grants`). Only Cursor
        // runs this way, and its grant only sets a variable.
        let harness = program.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        // The workspace's configured variables and bound secrets
        // (`cloud_config`) first, so a grant always wins.
        env.extend(crate::cloud_config::launch_config(&harness, &rt.key()).env);
        env.extend(crate::cloud_grants::agent_env_for_launch(&harness, &rt.key()).into_iter().filter_map(|(name, value)| value.map(|value| (name, value))));
        let child = self.host.spawn(&rt.key(), SpawnSpec { program, args, cwd: Path::new(cwd), env: &env }, sink)?;
        rt.child_pid = Some(child.pid);
        rt.child = Some(child);
        Ok(())
    }

    fn write(&self, rt: &TabRuntime, line: &str) -> Result<()> {
        rt.child.as_ref().context("the agent is not running")?.write_line(line)
    }

    /// Send a prompt. A tab mid-turn queues it for the next boundary.
    pub fn send(
        &self,
        session_id: &str,
        tab_id: &str,
        text: String,
        images: Vec<ImageInput>,
    ) -> Result<SendOutcome> {
        let mut sharing = self.sharing.lock().unwrap();
        if let Some(share) = sharing.sessions.get_mut(session_id) {
            share.host_takeover(tab_id, chrono::Utc::now().timestamp_millis());
            self.sink.emit("session_share_changed", &serde_json::json!({ "sessionId": session_id, "state": share.snapshot(chrono::Utc::now().timestamp_millis(), true) }));
            return self.send_impl(session_id, tab_id, PromptText { agent: text.clone(), display: text, author: Some(share.host.clone()), shared_connection: None }, images, None);
        }
        self.send_with_display_text(session_id, tab_id, text.clone(), text, images)
    }

    /// Continuations use the normal send path, but only acknowledge delivery
    /// when the provider echoes the prompt or runs its UserPromptSubmit hook.
    pub fn send_confirmed(&self, session_id: &str, tab_id: &str, text: String) -> Result<SendOutcome> {
        let (tx, rx) = std::sync::mpsc::channel();
        let outcome = self.send_impl(session_id, tab_id, PromptText { agent: text.clone(), display: text, author: None, shared_connection: None }, Vec::new(), Some(tx))?;
        rx.recv_timeout(std::time::Duration::from_secs(90))
            .map_err(|_| anyhow!("The new session opened, but prompt delivery could not be confirmed. Check its terminal before retrying; the prepared prompt is retained."))?
            .map_err(anyhow::Error::msg)?;
        Ok(outcome)
    }

    /// Read tracking only; preparing a handoff must never instantiate or start
    /// the source runtime (which can otherwise resume its provider session).
    pub fn tracked_transcript(&self, session_id: &str, tab_id: &str) -> Option<PathBuf> {
        let rt = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned()?;
        let rt = rt.lock().unwrap();
        match &rt.engine { Engine::Cli(p) => Some(p.tail.path()), _ => None }
    }

    /// Send one prompt to the agent while publishing a different, user-facing
    /// representation to the transcript.
    pub(crate) fn send_with_display_text(
        &self,
        session_id: &str,
        tab_id: &str,
        text: String,
        display_text: String,
        images: Vec<ImageInput>,
    ) -> Result<SendOutcome> {
        let outcome = self.send_impl(session_id, tab_id, PromptText { agent: text, display: display_text, author: None, shared_connection: None }, images, None);
        if let Err(error) = &outcome {
            if let Ok(rt) = self.runtime(session_id, tab_id) {
                self.apply(&mut rt.lock().unwrap(), Payload::Error { message: format!("{error:#}"), fatal: false }, None);
            }
        }
        outcome.map_err(|error| anyhow!(RecoveryKind::classify(&error.to_string()).message()))
    }

    /// Already admitted under `sharing`: use the same prompt writer as the host.
    pub(crate) fn send_shared(&self, session_id: &str, tab_id: &str, text: String, author: crate::local_sharing::Person, connection: crate::local_sharing::WritePermit) -> Result<SendOutcome> {
        self.send_impl(session_id, tab_id, PromptText { agent: text.clone(), display: text, author: Some(author), shared_connection: Some(connection) }, Vec::new(), None)
    }

    fn send_impl(
        &self, session_id: &str, tab_id: &str, prompt: PromptText,
        images: Vec<ImageInput>, receipt: Option<DeliveryReceipt>,
    ) -> Result<SendOutcome> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        let mut rt = rt_arc.lock().unwrap();
        if rt.stopping { bail!("Stop has not confirmed local process exit. Retry Stop before resuming."); }
        let (refs, wire_images) = Self::archive_images(session_id, &images)?;

        if receipt.is_some() && (pty_first(&tab.harness).is_none() || rt.turn_open || !rt.pending.is_empty()) {
            bail!("Continuation delivery requires an idle Claude Code or Codex destination.");
        }
        if prompt.shared_connection.is_some() && rt.turn_open {
            bail!("The agent started a turn. Queue this prompt or steer the agent.");
        }
        if pty_first(&tab.harness).is_some() {
            return self.send_to_cli(
                &mut rt,
                &rt_arc,
                &entry,
                prompt,
                refs,
                receipt,
            );
        }

        if rt.turn_open && rt.child.is_some() {
            let q = QueuedMessage {
                id: uuid::Uuid::now_v7().to_string(),
                text: prompt.agent.clone(),
                images: wire_images,
            };
            rt.queued.push(q);
            let ev = self.publish(
                &mut rt,
                Payload::UserMessage { author: prompt.author.clone(),
                    text: prompt.display,
                    images: refs,
                    baseline: None,
                    queued: true,
                    cwd: Some(entry.cwd.clone()),
                },
                None,
            );
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
        let events = vec![self.publish(
            &mut rt,
            Payload::UserMessage { author: prompt.author.clone(),
                text: prompt.display,
                images: refs,
                baseline,
                queued: false,
                cwd: Some(entry.cwd.clone()),
            },
            None,
        )];

        match &mut rt.engine {
            Engine::Acp(a) => {
                let actions = if a.ready {
                    a.prompt(prompt.agent.clone(), wire_images)
                } else {
                    a.start(prompt.agent.clone(), wire_images)
                };
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => {
                let actions = if o.ready {
                    o.prompt(prompt.agent.clone(), wire_images)
                } else {
                    o.start(prompt.agent.clone(), wire_images)
                };
                self.apply_actions(&mut rt, actions);
            }
            Engine::Cli(_) | Engine::None => bail!("no engine"),
        }
        rt.open_turn();
        rt.turn_started_at = Some(Instant::now());
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
                        self.apply(rt, Payload::Error { message: format!("Connection write failed: {e:#}"), fatal: false }, None);
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
        self.observer.interrupted(&rt.key());
        if rt.child.is_none() && !matches!(rt.engine, Engine::Cli(_)) {
            return Ok(());
        }
        self.record_activity(&rt, TabStatus::Idle, store::activity::Source::Live);
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
        let rt_arc = self.runtime(session_id, tab_id)?;
        let (pane, pid) = {
            let mut rt = rt_arc.lock().unwrap();
            if rt.stop_in_flight { bail!("Stop is already in progress."); }
            rt.stop_in_flight = true;
            rt.stopping = true;
            rt.queued.clear();
            let pid = rt.stopping_pid.or(rt.child_pid).or_else(|| {
                let pane = Self::pane_id(tab_id);
                self.terminals.panes().iter().find(|p| p.id == pane).and_then(|p| p.pid)
            });
            for request_id in rt.pending.drain().map(|(id, _)| id).collect::<Vec<_>>() {
                self.publish(&mut rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Cancelled".into(), automatic: true }, None);
            }
            rt.stopping_pid = pid;
            // Settle before waiting for the OS. Late exits cannot reopen this turn.
            self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
            let pane = self.release_cli(&mut rt);
            crate::cloud_grants::forget_launch(&key);
            rt.child = None;
            rt.child_pid = None;
            rt.engine = Engine::None;
            self.set_status(&mut rt, TabStatus::Idle);
            (pane, pid)
        };
        if let Some(pane) = pane {
            self.terminals.kill_and_wait(&pane, RESTART_WAIT);
        } else if self.host.is_live(&key) {
            self.host.kill(&key);
        } else if let Some(pid) = pid {
            crate::harness::host::terminate(pid);
        }
        let deadline = Instant::now() + RESTART_WAIT;
        while pid.is_some_and(crate::harness::host::is_alive) {
            if Instant::now() >= deadline {
                let mut rt = rt_arc.lock().unwrap();
                rt.stop_in_flight = false;
                self.needs_recovery(&mut rt, RecoveryKind::Disconnected);
                bail!("Local process exit could not be confirmed. Retry Stop before resuming.");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let mut rt = rt_arc.lock().unwrap();
        rt.stopping = false;
        rt.stop_in_flight = false;
        rt.stopping_pid = None;
        self.publish(&mut rt, Payload::Status { text: recovery::SESSION_CLOSED_MESSAGE.into() }, None);
        Ok(())
    }

    pub fn respond_permission(&self, session_id: &str, tab_id: &str, request_id: &str, option_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.child.is_none() && !matches!(rt.engine, Engine::Cli(_)) {
            rt.pending.remove(request_id);
            self.publish(&mut rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
            self.needs_recovery(&mut rt, RecoveryKind::PermissionExpired);
            bail!("the agent is no longer running; the request lapsed");
        }
        let ask = rt.pending.get(request_id).cloned().ok_or_else(|| anyhow!("that request is no longer open"))?;
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
                tx.send(decision).map_err(|_| anyhow!("the agent stopped waiting for that request"))?;
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
        rt.pending.remove(request_id);
        self.publish(&mut rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: Some(ask.tool_use_id), allowed: allow, label, automatic: false }, None);
        if rt.pending.is_empty() && !matches!(rt.engine, Engine::Cli(_)) {
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
                tx.send(Decision::Answers(input)).map_err(|_| anyhow!("the agent stopped waiting for that question"))?;
            }
            _ => bail!("that agent does not ask questions this way"),
        }
        self.publish(&mut rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: Some(ask.tool_use_id), allowed: true, label: "Answered".into(), automatic: false }, None);
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
                self.type_command(p, &rt_arc, format!("/model {model}"));
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

    /// Add an agent tab to a session, from whichever surface asked. A shared
    /// session takes no Bypass tab, and the share cannot start between the
    /// check and the save because both hold the sharing lock.
    pub fn add_tab(&self, session_id: &str, tab: &crate::session_ops::NewTab) -> Result<index::TabEntry> {
        let sharing = self.sharing.lock().unwrap();
        if sharing.sessions.contains_key(session_id) && index::permission_mode_or_default(tab.permission_mode.as_deref()) == "bypassPermissions" {
            bail!("New tabs in a shared session must use a permission mode other than Bypass.");
        }
        crate::session_ops::add_tab_entry(session_id, tab).map_err(|error| anyhow!(error))
    }

    pub fn set_permission_mode(&self, session_id: &str, tab_id: &str, mode: &str) -> Result<()> {
        let sharing = self.sharing.lock().unwrap();
        if mode == "bypassPermissions" && sharing.sessions.contains_key(session_id) {
            bail!("Stop sharing this session before switching to Bypass.");
        }
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
        drop(sharing);
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
                    self.type_command(p, &rt_arc, format!("/effort {e}"));
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
            crate::cloud_grants::forget_launch(&rt.key());
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
        if let Err(error) = store::activity::shutdown() {
            log::error!("flush activity on shutdown: {error:#}");
        }
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
        match self.start_cli(&mut rt, &rt_arc, &entry, &tab) {
            Ok(false) => self.announce_pane(&rt),
            Ok(true) => {},
            Err(error) => {
                self.apply(&mut rt, Payload::Error { message: format!("{error:#}"), fatal: false }, None);
                return Err(anyhow!(RecoveryKind::classify(&error.to_string()).message()));
            }
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
        // A delayed exit from a replaced pane must not forget what its
        // successor was launched with (its grant, its configuration and MCP
        // file).
        if !self.terminals.is_running(pane_id) {
            crate::cloud_grants::forget_launch(pane_id);
        }
        let Some(tab_id) = pane_id.strip_prefix("tab:") else { return };
        let Some(entry) = index::load().ok().and_then(|sessions| sessions.into_iter().find(|session| session.tab(tab_id).is_some())) else { return };
        let Ok(rt_arc) = self.runtime(&entry.id, tab_id) else { return };
        let mut rt = rt_arc.lock().unwrap();
        // A delayed exit from a replaced pane must not settle its successor.
        if !matches!(rt.engine, Engine::Cli(_)) || self.terminals.is_running(pane_id) { return; }
        let turn_was_open = rt.turn_open;
        let recovery = rt.recovery.or(turn_was_open.then_some(RecoveryKind::Failed));
        if turn_was_open { self.close_open_turn(&mut rt, TurnStatus::Error, None); }
        self.release_cli(&mut rt);
        if let Some(kind) = recovery { self.needs_recovery(&mut rt, kind); }
        drop(rt);
        if turn_was_open {
            let detail = code.map(|value| format!(" with exit code {value}")).unwrap_or_else(|| " from a signal".into());
            self.observer.automation_failed(&entry.id, tab_id, &format!("The agent process exited{detail} before the automation turn completed."));
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
            self.sink.emit("tab_pty", &ev);
        }
    }

    /// Returns whether this call is what started it, so a prompt sent in the
    /// same breath knows to wait for the TUI to finish drawing.
    fn start_cli(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry, tab: &TabEntry) -> Result<bool> {
        if rt.stopping { bail!("Stop has not confirmed local process exit. Retry Stop before resuming."); }
        let Some(kind) = pty_first(&tab.harness) else { return Ok(false) };
        let pane = Self::pane_id(&tab.id);
        if let Engine::Cli(p) = &rt.engine {
            if p.pane_id == pane && self.terminals.is_running(&pane) {
                return Ok(false);
            }
        }
        self.terminals.kill_and_wait(&pane, RESTART_WAIT);
        // A quick chat's scratch directory is ours to keep there: one removed
        // by hand is made again rather than failing the launch.
        if entry.is_quick() && crate::store::quick::is_scratch(&entry.id, &entry.cwd) {
            crate::store::quick::create(&entry.id).context("make the quick chat's scratch directory")?;
        }

        let exe = std::env::current_exe().context("locate this binary for the CLI's hooks")?;
        let mut env = vec![
            ("RACCOON_SESSION_ID".to_string(), rt.session_id.clone()),
            ("RACCOON_TAB_ID".to_string(), rt.tab_id.clone()),
            (crate::hooks::CONTROL_SOCKET_ENV.to_string(), self.control.socket.to_string_lossy().into_owned()),
            (crate::hooks::CONTROL_TOKEN_ENV.to_string(), self.control.token.clone()),
        ];
        // A fresh secret per launch, per tab: the socket path is inherited by
        // every process the agent starts, so what keeps one tab's hooks from
        // speaking for another is that only this CLI was given this token.
        let token = crate::hooks::mint_token();
        // This launch's own socket, not the home's published one: another
        // TerminalX on the same home may hold that, and it does not know
        // this tab (#202).
        env.push((crate::hooks::SOCKET_ENV.to_string(), self.control.socket.to_string_lossy().into_owned()));
        env.push((crate::hooks::TOKEN_ENV.to_string(), token.clone()));
        let launch = match kind {
            CliKind::Claude => self.claude_launch(entry, tab, &exe)?,
            CliKind::Codex => self.codex_launch(rt, entry, tab, &exe, &mut env)?,
        };

        // A cloud workspace's configuration (`cloud_config`): variables,
        // bound secrets, prompts and MCP servers. Before the grants, so an
        // agent credential always wins.
        let config = crate::cloud_config::launch_config(&tab.harness, &pane);
        env.extend(config.env);
        // A cloud workspace's agent credentials (`cloud_grants`); names to
        // unset are dropped after the login shell's profile has run.
        let mut unset = Vec::new();
        for (name, value) in crate::cloud_grants::agent_env_for_launch(&tab.harness, &pane) {
            match value {
                Some(value) => env.push((name, value)),
                None => unset.push(name),
            }
        }
        let spawned = crate::cloud_grants::unset_prefix(&format!("{}{}", launch.command, config.args), &unset);
        let usage_account = (kind == CliKind::Claude).then(crate::status::usage::claude_account_identity).flatten();
        let tail = Arc::new(launch.tail);
        let spec = pty::PaneSpec { cwd: &entry.cwd, cols: CLI_PANE_SIZE.0, rows: CLI_PANE_SIZE.1, command: Some(&spawned), env: &env };
        self.terminals.spawn(self.sink.clone(), &pane, spec).context("start the agent's CLI")?;
        let generation = self.starts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        rt.engine = Engine::Cli(CliTab {
            usage_account,
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
            awaiting_delivery: None,
            decisions: HashMap::new(),
            turn_tail: Default::default(),
            transcript_turn: None,
            transcript_end_owed: false,
            answered: HashMap::new(),
            command: launch.command,
            origin: Origin { token, transcript_root: launch.transcript_root, conversation: launch.conversation },
        });
        rt.turn_open = false;
        self.announce_pane(rt);
        if let Some(id) = launch.minted {
            index::update_tab(&rt.session_id, &rt.tab_id, |t| {
                t.provider_session_id = Some(id.clone());
                // `fork_from` stays: the CLI has only just started, and until
                // it has written the fork's own transcript the parent's is
                // the only copy of the conversation. A tab with an id of its
                // own resumes that id, so the field no longer drives launch.
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

        // The CLI's first-run screens — onboarding's theme picker on a fresh
        // machine, the trust dialog for a folder it has not seen — would take
        // the first prompt instead of the composer. The reader adopted this
        // checkout when they made the session.
        if let Err(e) = claude::trust::prepare(&entry.cwd) {
            log::warn!("prepare the Claude Code config for {}: {e:#}", entry.cwd);
        }
        // Where the conversation's file is, not where a conversation started
        // in this folder would be: a resumed one is still written where it
        // began, which a renamed workspace no longer derives (#250).
        let projects = claude::transcript::projects_root().ok_or_else(|| anyhow!("no home directory"))?;
        let derived = claude::transcript::transcript_in(&projects, &entry.cwd, &provider_id);
        let path = claude::transcript::locate_in(&projects, &entry.cwd, &provider_id);
        // The folder derived from the checkout is where the CLI files what
        // it starts here, and a file it reports has to be in it — or be this
        // conversation's own, in the folder it was found in. Both stay
        // allowed: which of the two a `/clear` opens its new file in is the
        // CLI's business.
        let transcript_root = derived.parent().context("the transcript path has no directory")?.to_path_buf();
        let mut conversation = crate::hooks::ConversationFile::new(projects, format!("{provider_id}.jsonl"));
        if path != derived {
            conversation.adopt(&path);
        }
        // A fork is handed a copy of the whole parent conversation, written
        // into its new file when the first turn lands. The app already has all
        // of it, and the copy keeps each record's original uuid, so those are
        // the ones to drop.
        let carried = fork_from.as_deref().and_then(|parent| claude::transcript::record_uuids(&entry.cwd, parent)).unwrap_or_default();
        Ok(CliLaunch {
            command,
            tail: tui::Tail::opening(path, claude::transcript::decode_line, carried).marking(claude::transcript::decode_marked),
            minted: (!resume).then_some(provider_id),
            transcript_root,
            conversation: Some(conversation),
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
                Some(path) => tui::Tail::opening(path, codex::rollout::decode_line, Default::default()).marking(codex::rollout::decode_marked),
                None => tui::Tail::unknown(codex::rollout::decode_line).marking(codex::rollout::decode_marked),
            },
            minted: None,
            // Codex names its own rollout, and only ever under the home
            // Raccoon built for it.
            transcript_root: home.join("sessions"),
            conversation: None,
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
        crate::cloud_grants::forget_launch(&pane);
        for request_id in rt.pending.drain().map(|(id, _)| id).collect::<Vec<_>>() {
            self.publish(rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
        }
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
                    let recovery = rt.recovery.or(rt.turn_open.then_some(RecoveryKind::Failed));
                    manager.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                    manager.release_cli(&mut rt);
                    if let Some(kind) = recovery { manager.needs_recovery(&mut rt, kind); }
                }
                return;
            }
        });
    }

    /// Publish everything the transcript has gained since the last look. The
    /// tail's own lock orders this against the poll loop, so a `Stop` hook
    /// flushing before it closes the turn cannot overtake it.
    fn pump(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>) {
        let (payloads, mark) = tail.drain_marked();
        if payloads.is_empty() && mark.is_none() {
            return;
        }
        let mut rt = rt_arc.lock().unwrap();
        rt.last_activity = Instant::now();
        if !payloads.is_empty() {
            self.stall_disproved(&mut rt);
        }
        let turn_open = rt.turn_open;
        if let Engine::Cli(p) = &mut rt.engine {
            expire_composer_echoes(&mut p.echoed, turn_open, Instant::now());
        }
        for payload in payloads {
            // A prompt sent from the composer was published when it was sent;
            // the transcript's copy of it would be the same message twice.
            // Anything else the transcript calls a prompt was typed into the
            // terminal, and this is the only record of it (#250).
            let echoed = match &mut rt.engine {
                Engine::Cli(p) => consume_composer_echo(&mut p.echoed, &payload),
                _ => None,
            };
            if let Some(echo) = echoed {
                if matches!(&rt.engine, Engine::Cli(p) if p.awaiting_delivery == Some(echo.seq)) {
                    self.delivery_confirmed(&mut rt);
                }
                // A queued prompt the CLI held until its turn was over is the
                // start of the next one. The `UserPromptSubmit` hook may have
                // opened that turn already, but only a prompt resets the latch
                // that lets `Stop` close it, and this record is that prompt.
                let held = echo.queued && (!rt.turn_open || matches!(&rt.engine, Engine::Cli(p) if p.turn_tail.is_closed()));
                if held {
                    if !rt.turn_open {
                        rt.open_turn();
                        rt.turn_started_at = Some(Instant::now());
                    }
                    if let Engine::Cli(p) = &mut rt.engine {
                        p.turn_tail.opened();
                    }
                    // The message itself is not published again; this says
                    // which one the new turn is the answer to.
                    self.publish(&mut rt, Payload::TurnStarted { model: None, provider_session_id: None, prompt_seq: Some(echo.seq) }, None);
                    self.set_status(&mut rt, TabStatus::InProgress);
                }
                continue;
            }
            if let (Payload::AssistantText { text, .. }, Engine::Cli(p)) = (&payload, &mut rt.engine) {
                if !p.turn_tail.observe(text) {
                    continue; // the app already said this for a Stop hook
                }
            }
            if matches!(payload, Payload::UserMessage { .. }) {
                self.delivery_confirmed(&mut rt);
                rt.open_turn();
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
                // A transcript may supply a completion the hook missed. It
                // may close actual live work but never open a replayed start.
                self.record_activity(&rt, TabStatus::Completed, store::activity::Source::Replay);
            }
            self.apply(&mut rt, payload, None);
        }
        // Recorded after the payloads, so an end never gets ahead of the
        // reply before it, and only against an open turn: the end of a turn
        // the hooks already closed says nothing about the next one. That
        // holds when the next one has opened in the meantime too, which is
        // what `transcript_end_owed` is for: a prompt sent right after `Stop`
        // is open before the transcript gets round to the turn before it.
        let open = rt.turn_open;
        if let (Some(mark), Engine::Cli(p)) = (mark, &mut rt.engine) {
            let owed = std::mem::take(&mut p.transcript_end_owed);
            if !(owed && mark == tui::TurnMark::Ended) {
                p.transcript_turn = open.then_some(mark);
            }
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
        self.end_open_turn(rt, status, final_text);
    }

    /// Publish the boundary of the turn that is open, whatever the latch
    /// says. `turn_open` is the guard: the boundary clears it, so this cannot
    /// publish a second one for the same turn. The latch is taken on the way,
    /// so a transcript record that would close the turn again finds it shut.
    fn end_open_turn(&self, rt: &mut TabRuntime, status: TurnStatus, final_text: Option<String>) {
        if !rt.turn_open {
            return;
        }
        if let Engine::Cli(p) = &mut rt.engine {
            let _ = p.turn_tail.closing();
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
        prompt: PromptText,
        images: Vec<ImageRef>,
        receipt: Option<DeliveryReceipt>,
    ) -> Result<SendOutcome> {
        let tab = entry.tab(&rt.tab_id).ok_or_else(|| anyhow!("tab not found"))?;
        self.start_cli(rt, rt_arc, entry, tab)?;
        let (pane, ready) = match &rt.engine {
            Engine::Cli(p) => (p.pane_id.clone(), p.ready.clone()),
            _ => bail!("the agent is not running"),
        };
        let paths: Vec<String> = images.iter().map(|i| i.url.clone()).collect();
        let agent = prompt.agent.clone();
        let (ev, queued) = self.record_composer_prompt(rt, &prompt, images, &entry.cwd, receipt.clone());
        self.type_prompt(rt_arc, &pane, agent, paths, PromptDelivery {
            ready: Some(ready),
            receipt: receipt.map(|receipt| (ev.seq, receipt)),
            shared: prompt.shared_connection.map(|connection| (connection, entry.id.clone(), tab.id.clone(), ev.seq)),
        });
        Ok(SendOutcome { queued, events: vec![ev] })
    }

    /// The composer's half of a prompt: publish it, open the turn if none is
    /// running, and remember that the CLI's own record of it is still to
    /// come, so that record is not drawn as a second message. Everything
    /// except the keystrokes.
    fn record_composer_prompt(&self, rt: &mut TabRuntime, prompt: &PromptText, images: Vec<ImageRef>, cwd: &str, receipt: Option<DeliveryReceipt>) -> (AgentEvent, bool) {
        let queued = rt.turn_open;
        let baseline = if queued { None } else { git::snapshot_tree(Path::new(cwd)).ok() };
        let (message, mut echo) = cli_composer_message(prompt, images, baseline, queued, cwd);
        let ev = self.publish(rt, message, None);
        if let Engine::Cli(p) = &mut rt.engine {
            echo.receipt = receipt;
            echo.seq = ev.seq;
            expire_composer_echoes(&mut p.echoed, queued, Instant::now());
            p.echoed.push_back(echo);
            if !queued {
                p.turn_tail.opened();
                p.awaiting_delivery = Some(ev.seq);
            }
        }
        if !queued {
            rt.open_turn();
            rt.turn_started_at = Some(Instant::now());
            self.set_status(rt, TabStatus::InProgress);
        }
        (ev, queued)
    }

    /// Write into a pane on its own thread, under that pane's write lock. The
    /// Enter has to be a later write than the body — a carriage return inside
    /// the same one is read as part of the paste and never submits — so this
    /// sleeps, which no caller holding the tab lock could afford to do.
    fn type_prompt(&self, rt_arc: &Arc<Mutex<TabRuntime>>, pane: &str, text: String, attachments: Vec<String>, delivery: PromptDelivery) {
        let PromptDelivery { ready, receipt, shared } = delivery;
        let lock = self.writers.lock().unwrap().entry(pane.to_string()).or_default().clone();
        let terminals = self.terminals.clone();
        let manager = self.clone();
        let rt_arc = rt_arc.clone();
        let pane = pane.to_string();
        let spawn_receipt = receipt.clone();
        let spawned = std::thread::Builder::new().name("cli-input".into()).spawn(move || {
            let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ready) = &ready {
                let readiness = manager.wait_ready(&pane, ready, shared.as_ref());
                let mut rt = rt_arc.lock().unwrap();
                // Stop or a restart may have replaced the CLI while waiting.
                if !matches!(&rt.engine, Engine::Cli(p) if Arc::ptr_eq(&p.ready, ready)) {
                    return;
                }
                if readiness == Readiness::Cancelled {
                    if let Some((_, _, _, seq)) = &shared { manager.cancel_shared_prompt(&mut rt, *seq); }
                    return;
                }
                if !manager.prepare_prompt(&mut rt, readiness, receipt.as_ref().map(|(_, receipt)| receipt)) {
                    return;
                }
            }
            let mut admitted_to_writer = false;
            let result = (|| -> Result<()> {
                let mut sharing = shared.as_ref().map(|_| manager.sharing.lock().unwrap());
                if let (Some((connection, session_id, tab_id, _)), Some(sharing)) = (&shared, &mut sharing) {
                    let share = sharing.sessions.get_mut(session_id).ok_or_else(|| anyhow!("Sharing ended before prompt delivery."))?;
                    share.admit_at_writer(connection, tab_id, chrono::Utc::now().timestamp_millis())?;
                    let current = index::get(session_id)?;
                    let tab = current.tab(tab_id).ok_or_else(|| anyhow!("Tab closed before prompt delivery."))?;
                    if tab.permission_mode == "bypassPermissions" || manager.pane_of(session_id, tab_id).is_none_or(|current| current.pane_id != pane) {
                        bail!("The shared tab changed before prompt delivery.");
                    }
                }
                admitted_to_writer = true;
                terminals.write(&pane, tui::CLEAR_LINE)?;
                for path in &attachments {
                    terminals.write(&pane, &tui::attachment_bytes(path))?;
                }
                if !attachments.is_empty() {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
                let body = tui::body_bytes(&text);
                terminals.write(&pane, &body)?;
                std::thread::sleep(tui::submit_delay(body.len()));
                if let Some((seq, _)) = &receipt {
                    // Hold the runtime lock across Enter and arming so a fast
                    // submit hook/echo cannot arrive between the two.
                    let mut rt = rt_arc.lock().unwrap();
                    terminals.write(&pane, tui::SUBMIT)?;
                    if let Engine::Cli(p) = &mut rt.engine {
                        if let Some(echo) = p.echoed.iter_mut().find(|echo| echo.seq == *seq) {
                            echo.submitted = true;
                        }
                    }
                } else {
                    terminals.write(&pane, tui::SUBMIT)?;
                }
                Ok(())
            })();
            if let Err(e) = result {
                log::warn!("[{pane}] write: {e:#}");
                let mut rt = rt_arc.lock().unwrap();
                if !admitted_to_writer {
                    if let Some((_, _, _, seq)) = &shared { manager.cancel_shared_prompt(&mut rt, *seq); return; }
                }
                if ready.as_ref().is_some_and(|ready| !matches!(&rt.engine, Engine::Cli(p) if Arc::ptr_eq(&p.ready, ready))) {
                    return;
                }
                if let Some((_, receipt)) = receipt {
                    rt.turn_open = false;
                    manager.set_status(&mut rt, TabStatus::Idle);
                    let _ = receipt.send(Err(format!("The new session opened, but writing its continuation prompt failed: {e}. The prepared prompt is retained.")));
                } else if ready.is_some() && matches!(&rt.engine, Engine::Cli(p) if p.awaiting_delivery.is_some()) {
                    manager.needs_recovery(&mut rt, RecoveryKind::DeliveryUnconfirmed);
                    rt.stalled_at = Some(Instant::now());
                }
            }
        });
        if let (Err(e), Some((_, receipt))) = (spawned, spawn_receipt) {
            let _ = receipt.send(Err(format!("Could not start prompt delivery: {e}")));
        }
    }

    fn cancel_shared_prompt(&self, rt: &mut TabRuntime, seq: u64) {
        let owns_pending = if let Engine::Cli(cli) = &mut rt.engine {
            cli.echoed.retain(|echo| echo.seq != seq);
            if cli.awaiting_delivery == Some(seq) { cli.awaiting_delivery = None; true } else { false }
        } else { false };
        if owns_pending {
            self.end_open_turn(rt, TurnStatus::Aborted, None);
            self.set_status(rt, TabStatus::Idle);
        }
    }

    /// Decide whether to type after readiness has settled. A quiet-screen
    /// timeout says nothing about delivery: send normally and let transcript,
    /// hooks and terminal activity inform the single recovery banner.
    fn prepare_prompt(&self, rt: &mut TabRuntime, readiness: Readiness, receipt: Option<&DeliveryReceipt>) -> bool {
        if let Readiness::Blocked(message) = readiness {
            log::warn!("[{}] the CLI is on a first-run screen: {message}", rt.key());
            rt.turn_open = false;
            self.apply(rt, Payload::Error { message: message.to_string(), fatal: false }, None);
            self.set_status(rt, TabStatus::Idle);
            if let Some(receipt) = receipt {
                let _ = receipt.send(Err(format!("{message} The prepared prompt is retained.")));
            }
            return false;
        }
        if readiness == Readiness::TimedOut {
            if let Some(receipt) = receipt {
                rt.turn_open = false;
                self.set_status(rt, TabStatus::Idle);
                let _ = receipt.send(Err("The new session did not become ready. Context was not sent; the prepared prompt is retained.".into()));
                return false;
            }
            log::warn!("[{}] never reported ready; typing the prompt and watching for delivery", rt.key());
        }
        // Startup time must not consume the prompt's delivery grace period.
        rt.last_activity = Instant::now();
        true
    }

    /// Wait until the pane's CLI is listening, blocked on setup, or out of time.
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
    ///
    /// A quiet Claude pane that never said it was up is read before it is
    /// trusted: the CLI's first-run screens (onboarding, trust, a custom API
    /// key, the bypass disclaimer) are quiet too, and are `Blocked`.
    fn wait_ready(&self, pane: &str, ready: &tui::Ready, shared: Option<&(crate::local_sharing::WritePermit, String, String, u64)>) -> Readiness {
        let deadline = Instant::now() + tui::READY_TIMEOUT;
        let blocked = || {
            if !ready.announces_start() {
                return None;
            }
            self.terminals.read_output(pane).and_then(|out| claude::pty::blocking_screen(&out))
        };
        loop {
            if let Some((permit, session, tab, _)) = shared {
                if self.sharing.lock().unwrap().sessions.get(session).is_none_or(|share| !share.permit_current(permit, tab, chrono::Utc::now().timestamp_millis())) {
                    return Readiness::Cancelled;
                }
            }
            if ready.settled() {
                return Readiness::Ready;
            }
            if !self.terminals.is_running(pane) {
                log::warn!("[{pane}] exited before it was ready");
                return Readiness::TimedOut;
            }
            if Instant::now() >= deadline {
                return blocked().map_or(Readiness::TimedOut, Readiness::Blocked);
            }
            if self.terminals.quiet_for(pane).is_some_and(|q| q >= tui::READY_QUIET) {
                if let Some(message) = blocked() {
                    return Readiness::Blocked(message);
                }
                if ready.announces_start() {
                    log::warn!("[{pane}] never ran its SessionStart hook; falling back to quiet output");
                }
                return Readiness::Ready;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// A slash command the CLI runs itself (`/model`, `/effort`).
    ///
    /// The CLI records it in the transcript like any other typed command. It
    /// is the app's keystroke, not the reader's prompt, so its record is
    /// expected here and dropped when it lands rather than drawn as a
    /// message nobody sent.
    fn type_command(&self, p: &mut CliTab, rt_arc: &Arc<Mutex<TabRuntime>>, command: String) {
        p.echoed.push_back(ComposerEcho { command: true, ..ComposerEcho::new(command.clone(), 0) });
        self.type_prompt(rt_arc, &p.pane_id, command, Vec::new(), PromptDelivery::default());
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
        // Every refusal says why, both here and back to the hook: a CLI whose
        // frames go unheard is a chat that never shows its reply (#202).
        let refuse = |reason: String| {
            log::warn!("hook {} for {}/{} refused by pid {} at {}: {reason}", frame.event, frame.session, frame.tab, std::process::id(), self.control.socket.display());
            HookReply::refused(reason)
        };
        let rt_arc = match self.runtime(&frame.session, &frame.tab) {
            Ok(rt_arc) => rt_arc,
            Err(error) => return refuse(format!("this TerminalX has no such tab ({error:#})")),
        };
        let (kind, tail, asks_every_tool, origin, usage_account) = {
            let rt = rt_arc.lock().unwrap();
            match &rt.engine {
                Engine::Cli(p) => (p.harness, p.tail.clone(), p.harness == CliKind::Codex && codex::asks_every_tool(&p.mode), p.origin.clone(), p.usage_account.clone()),
                // A hook from a CLI this app did not start, or from one whose
                // tab has moved on: nothing to say, and nothing to block.
                _ => return refuse("this TerminalX did not start the tab's CLI, or the tab has since moved on".into()),
            }
        };
        // The socket is owner-only, but so is everything else this user runs,
        // including whatever the agent itself starts. A frame that cannot
        // show this launch's token did not come from this tab's CLI, and
        // answering it would let one tab decide another tab's permissions.
        if !origin.accepts(&frame) {
            return refuse("the frame's token is not the one this tab's CLI launch was given".into());
        }
        if frame.event == "StatusLine" {
            if kind == CliKind::Claude && self.status.usage.ingest_claude(usage_account.as_deref(), &frame.payload) {
                self.emit_usage();
            }
            return HookReply::default();
        }
        // Stop at hook receipt, before transcript settling/git snapshots, so
        // time spent waiting for display bookkeeping is not agent work.
        if matches!(frame.event.as_str(), "Stop" | "Interrupt" | "SessionEnd") {
            self.record_activity(&rt_arc.lock().unwrap(), TabStatus::Completed, store::activity::Source::Live);
        }
        // Claude's transcript path is a guess made before the CLI ran and
        // Codex's is not knowable at all until now; either way the hook
        // carries the file it actually opened — but only a file this CLI
        // could have opened, so a frame cannot aim the tail at, say, the
        // reader's private notes and have the chat read them out.
        //
        // Judged on the tab's own copy, under its lock: what a frame is
        // allowed to name can grow (a folder the conversation is found in, a
        // file the CLI announces), and has to still be so for the next one.
        let named = match &mut rt_arc.lock().unwrap().engine {
            Engine::Cli(p) if p.origin.accepts(&frame) => p.origin.transcript(&frame),
            _ => None,
        };
        match (frame.payload["transcript_path"].as_str(), named) {
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

        // Codex creates its session on the first prompt; Claude announces
        // startup before accepting input, so its SessionStart proves less.
        if matches!(frame.event.as_str(), "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop")
            || (kind == CliKind::Codex && frame.event == "SessionStart") {
            let mut rt = rt_arc.lock().unwrap();
            if matches!(&rt.engine, Engine::Cli(p) if p.origin.accepts(&frame)) {
                self.delivery_confirmed(&mut rt);
            }
        }

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
                // A settings restart/teardown may have replaced this launch
                // while its transcript was being drained above.
                if !matches!(&rt.engine, Engine::Cli(p) if p.origin.accepts(&frame)) {
                    return HookReply::default();
                }
                if frame.event == "UserPromptSubmit" {
                    if let Engine::Cli(p) = &mut rt.engine {
                        for echo in p.echoed.iter_mut().filter(|echo| echo.submitted && !echo.queued && !echo.command) {
                            // A timed-out receipt must not absorb a later
                            // submission's hook. Keep its echo for deduplication.
                            if echo.confirm_delivery() { break; }
                        }
                    }
                }
                rt.last_activity = Instant::now();
                if !rt.turn_open {
                    rt.open_turn();
                    rt.turn_started_at = Some(Instant::now());
                }
                if rt.pending.is_empty() {
                    self.record_activity(&rt, TabStatus::InProgress, store::activity::Source::Live);
                    self.set_status(&mut rt, TabStatus::InProgress);
                }
                drop(rt);
                if frame.event == "UserPromptSubmit" {
                    self.observer.automation_running(&frame.session, &frame.tab);
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
                if rt.turn_open {
                    self.close_open_turn(&mut rt, TurnStatus::Ok, final_text.clone());
                    self.after_turn_completed(&rt_arc, rt, final_text);
                    return HookReply::default();
                }
            }
            // Codex only: the reader pressed Escape in the TUI.
            "Interrupt" => {
                let mut rt = rt_arc.lock().unwrap();
                self.forget_tool_answers(&mut rt);
                self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                drop(rt);
                self.observer.automation_failed(&frame.session, &frame.tab, "The automation turn was interrupted.");
            }
            "SessionEnd" => {
                let mut rt = rt_arc.lock().unwrap();
                let turn_was_open = rt.turn_open;
                self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                self.set_status(&mut rt, TabStatus::Idle);
                drop(rt);
                if turn_was_open {
                    self.observer.automation_failed(
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

    /// Finish a Stop hook or a watcher-closed turn. Forget its answers while
    /// still holding the tab lock, then release it before notifying automation
    /// or scheduling a settings restart that may re-enter the tab.
    fn after_turn_completed(&self, rt_arc: &Arc<Mutex<TabRuntime>>, mut rt: MutexGuard<'_, TabRuntime>, final_message: Option<String>) {
        self.forget_tool_answers(&mut rt);
        let (session, tab) = (rt.session_id.clone(), rt.tab_id.clone());
        drop(rt);
        self.observer.automation_completed(&session, &tab, final_message);
        self.restart_if_due(rt_arc, &session, &tab);
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
            if !p.origin.accepts(frame) { return HookReply::default(); }
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
            rt.pending.insert(
                request_id.clone(),
                PendingAsk { tool_use_id: String::new(), tool_name: tool_name.clone(), input: input.clone(), suggestions },
            );
            self.apply(&mut rt, payload, None);
        }
        let wait = match kind {
            CliKind::Claude => claude::pty::PERMISSION_WAIT,
            CliKind::Codex => codex::pty::PERMISSION_WAIT,
        };
        let answer = wait_for_decision(rx, wait);
        let mut rt = rt_arc.lock().unwrap();
        // Teardown or a settings restart may replace this CLI while the hook
        // waits. An answer for that old launch cannot start the new one's work.
        if !matches!(&rt.engine, Engine::Cli(p) if p.origin.accepts(frame)) {
            return HookReply::default();
        }
        if let Engine::Cli(p) = &mut rt.engine {
            p.decisions.remove(&request_id);
            if let Some(d) = &answer {
                p.answered.insert(tool_key(&tool_name, &input), !matches!(d, Decision::Deny));
            }
        }
        match answer {
            Some(decision) => {
                if rt.pending.is_empty() {
                    self.record_activity(&rt, TabStatus::InProgress, store::activity::Source::Live);
                    self.set_status(&mut rt, TabStatus::InProgress);
                }
                reply_for(kind, gate, decision)
            }
            None => {
                // The CLI has stopped waiting on us and will ask in its own
                // TUI; the card must stop offering buttons that go nowhere.
                self.apply(&mut rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
                self.needs_recovery(&mut rt, RecoveryKind::PermissionExpired);
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
        self.stall_disproved(&mut rt);
        self.apply_actions(&mut rt, actions);
    }

    fn apply(&self, rt: &mut TabRuntime, payload: Payload, subagent: Option<SubagentRef>) {
        if subagent.is_none() {
            if matches!(&payload, Payload::ModelRequestStarted | Payload::Reasoning { .. } | Payload::Delta(Delta::ThinkingDelta { .. }) | Payload::ToolCallCompleted { .. }) {
                self.delivery_confirmed(rt);
            }
            if matches!(&payload, Payload::AssistantText { .. } | Payload::Delta(Delta::TextDelta { .. }) | Payload::ToolCallStarted { .. }) {
                self.delivery_confirmed(rt);
                if rt.pending.is_empty() && rt.recovery.is_some() && rt.recovery != Some(RecoveryKind::PermissionExpired) {
                    self.set_status(rt, TabStatus::InProgress);
                }
            }
            // The watcher's timeout is a guess that the turn is stuck, and a
            // turn that has ended is not. A failed ending raises its own
            // recovery just below.
            if payload.is_turn_boundary() && rt.stalled_at.take().is_some() && rt.recovery.take().is_some() {
                self.publish(rt, Payload::Recovery { kind: None }, None);
            }
            if let Some(kind) = recovery::failure(&payload) { self.needs_recovery(rt, kind); }
        }
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
            Payload::PermissionRequested { request_id, tool_use_id, tool_name, input, .. } => {
                rt.pending.entry(request_id.clone()).or_insert_with(|| PendingAsk {
                    tool_use_id: tool_use_id.clone(),
                    tool_name: tool_name.clone(),
                    input: input.clone(),
                    suggestions: Vec::new(),
                });
                self.set_status(rt, TabStatus::Waiting);
            }
            Payload::QuestionsAsked { .. } => self.set_status(rt, TabStatus::Waiting),
            Payload::PermissionDecided { request_id, automatic: true, label, .. } => {
                rt.pending.remove(request_id);
                if rt.pending.is_empty() && rt.status == TabStatus::Waiting && label != "Lapsed" {
                    self.set_status(rt, TabStatus::InProgress);
                }
            }
            _ => {}
        }

        let is_boundary = payload.is_turn_boundary();
        let aborted = matches!(&payload, Payload::TurnCompleted { status: TurnStatus::Aborted, .. });
        if is_boundary {
            self.record_activity(rt, TabStatus::Completed, store::activity::Source::Replay);
        }
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
            if let Engine::Cli(p) = &mut rt.engine {
                p.awaiting_delivery = None;
                p.transcript_end_owed = p.transcript_turn.take() != Some(tui::TurnMark::Ended);
                // An interrupted CLI hands what was queued back to its own
                // input rather than sending it. If it does send one after
                // all, that is a second message — which is better than the
                // same words typed into the terminal next going missing.
                if aborted {
                    p.echoed.retain(|prompt| !prompt.queued);
                }
            }
            if !aborted && rt.recovery.is_none() && !rt.queued.is_empty() {
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
                    rt.open_turn();
                    rt.turn_started_at = Some(Instant::now());
                    self.set_status(rt, TabStatus::InProgress);
                    return;
                }
            }
            self.set_status(rt, if rt.recovery.is_some() { TabStatus::Waiting } else if aborted { TabStatus::Idle } else { TabStatus::Completed });
        }
    }

    fn on_exit(&self, rt_arc: &Arc<Mutex<TabRuntime>>, pid: u32, code: Option<i32>) {
        let mut rt = rt_arc.lock().unwrap();
        if rt.child_pid != Some(pid) {
            return; // an older child; the live one is unaffected
        }
        crate::cloud_grants::forget_launch(&rt.key());
        rt.child = None;
        rt.child_pid = None;
        rt.engine = Engine::None;
        let pending: Vec<String> = rt.pending.drain().map(|(k, _)| k).collect();
        for request_id in pending {
            self.publish(&mut rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
        }
        let recovery = rt.recovery.or((rt.turn_open && code != Some(0)).then_some(RecoveryKind::Failed));
        if rt.turn_open {
            rt.turn_open = false;
            let duration_ms = rt.turn_started_at.map(|t| t.elapsed().as_millis() as u64);
            let status = if code == Some(0) { TurnStatus::Aborted } else { TurnStatus::Error };
            let final_text = (status == TurnStatus::Error).then(|| format!("The agent exited unexpectedly (code {}).", code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into())));
            self.publish(&mut rt, Payload::TurnCompleted { status, final_text, usage: None, duration_ms, head: None, auth_failed: false }, None);
        }
        rt.queued.clear();
        if let Some(kind) = recovery { self.needs_recovery(&mut rt, kind); }
        else { self.set_status(&mut rt, TabStatus::Idle); }
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
#[path = "session_watch_tests.rs"]
mod watch_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    #[test]
    fn permission_timeout_disconnects_before_runtime_lock_cleanup() {
        let runtime_lock = Arc::new(Mutex::new(()));
        let held = runtime_lock.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let (timed_out, observed) = std::sync::mpsc::channel();
        let hook_lock = runtime_lock.clone();
        let hook = std::thread::spawn(move || {
            let answer = wait_for_decision(rx, std::time::Duration::ZERO);
            timed_out.send(answer.is_none()).unwrap();
            let _cleanup = hook_lock.lock().unwrap();
            answer
        });
        assert!(observed.recv_timeout(std::time::Duration::from_secs(2)).unwrap());
        // The hook has timed out but cannot clean up its pending request yet.
        // A UI response in this exact window must fail, not start idle timing.
        assert!(tx.send(Decision::Allow).is_err());
        drop(held);
        assert!(hook.join().unwrap().is_none());
    }

    #[test]
    fn permission_receipt_preserves_all_delivered_decisions() {
        for decision in [Decision::Allow, Decision::Deny, Decision::Answers(json!({"answers": {"question": "answer"}}))] {
            let (tx, rx) = std::sync::mpsc::channel();
            tx.send(decision.clone()).unwrap();
            let received = wait_for_decision(rx, std::time::Duration::ZERO).unwrap();
            assert_eq!(std::mem::discriminant(&received), std::mem::discriminant(&decision));
            if let Decision::Answers(input) = received {
                assert_eq!(input["answers"]["question"], "answer");
            }
            assert!(tx.send(Decision::Allow).is_err());
        }
    }

    #[test]
    fn codex_image_prompts_project_once_and_repeated_submissions_stay_distinct() {
        let prompt = PromptText { shared_connection: None, author: None, agent: "describe this".into(), display: "describe this".into() };
        let image = ImageRef { url: "attachments/session/proof.png".into(), media_type: Some("image/png".into()), name: Some("proof.png".into()) };
        let mut pending = std::collections::VecDeque::new();
        let mut projected = Vec::new();

        for _ in 0..2 {
            let (composer, echo) = cli_composer_message(&prompt, vec![image.clone()], None, false, "/workspace");
            pending.push_back(echo);
            projected.push(composer);

            let rollout = Payload::UserMessage { author: None, text: "[Image #1] describe this".into(), images: Vec::new(), baseline: None, queued: false, cwd: None };
            assert_eq!(consume_composer_echo(&mut pending, &rollout), Some(Echoed { queued: false, seq: 0 }));
        }

        assert_eq!(projected.len(), 2, "one projected record per real submission");
        assert!(projected.iter().all(|p| matches!(p, Payload::UserMessage { text, images, .. } if text == "describe this" && images.as_slice() == std::slice::from_ref(&image))));
    }

    #[test]
    fn composer_echo_matching_is_strict_about_attachments() {
        assert!(ComposerEcho::new("plain".into(), 0).matches("plain"));
        assert!(!ComposerEcho::new("plain".into(), 0).matches("[Image #1] plain"));
        assert!(ComposerEcho::new("compare".into(), 2).matches("[Image #1] [Image #2] compare"));
        assert!(!ComposerEcho::new("compare".into(), 2).matches("[Image #1] compare"));
        assert!(!ComposerEcho::new("compare".into(), 1).matches("[Image #1] [Image #2] compare"));
        assert!(ComposerEcho::new(String::new(), 1).matches("[Image #1]"));
    }

    /// Claude Code writes the pasted-image labels straight into the prompt
    /// with nothing between the last label and the text; Codex leaves a
    /// space. The echo is the same prompt either way.
    #[test]
    fn composer_echo_matching_tolerates_claude_label_spacing() {
        let echo = ComposerEcho::new("create another issue".into(), 3);
        assert!(echo.matches("[Image #1] [Image #2] [Image #3]create another issue"));
        assert!(echo.matches("[Image #1][Image #2][Image #3] create another issue"));
        assert!(echo.matches("[Image #1] [Image #2] [Image #3] create another issue\n"));
        assert!(!echo.matches("[Image #1] [Image #3] [Image #2]create another issue"));
        assert!(!ComposerEcho::new("[Image #1] literal".into(), 0).matches("[Image #1] literal"));
        assert_eq!(strip_image_labels("[Image #1] [Image #12]x"), (1, " [Image #12]x"));
        assert_eq!(strip_image_labels("[Image #] x"), (0, "[Image #] x"));
        assert_eq!(strip_image_labels("[Image #1 x"), (0, "[Image #1 x"));
    }

    #[test]
    fn delivery_is_confirmed_by_the_matching_provider_echo_after_submission() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut echo = ComposerEcho::new("continuation prompt".into(), 0);
        echo.receipt = Some(tx);
        let mut pending = std::collections::VecDeque::from([echo]);
        let message = |text: &str| Payload::UserMessage { author: None, text: text.into(), images: Vec::new(), baseline: None, queued: false, cwd: None };
        assert!(consume_composer_echo(&mut pending, &message("continuation prompt")).is_none());
        assert!(rx.try_recv().is_err(), "a prompt still waiting for readiness is not delivered");
        pending[0].submitted = true;
        assert!(consume_composer_echo(&mut pending, &message("unrelated prompt")).is_none());
        assert!(rx.try_recv().is_err());
        assert!(consume_composer_echo(&mut pending, &message("continuation prompt")).is_some());
        assert_eq!(rx.try_recv().unwrap(), Ok(()));
        assert!(consume_composer_echo(&mut pending, &message("continuation prompt")).is_none());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn composer_echo_matches_pasted_content_and_whitespace_without_accepting_partial_prompts() {
        let text = format!("Continue work\n\n{}\nKeep the transcript unchanged.", "historical context ".repeat(1000));
        let echo = ComposerEcho::new(text.clone(), 0);
        assert!(echo.matches(&format!("<pasted_content id=\"1\">\n{text}\n</pasted_content>")));
        assert!(echo.matches(&format!("<pasted_content id=\"1\">\n{text}\n</pasted_content id=\"1\">")));
        assert!(echo.matches(&text.split_whitespace().collect::<Vec<_>>().join(" \r\n\t")));
        assert!(ComposerEcho::new("first part second part".into(), 0).matches(
            "<pasted_content id=\"1\">first part</pasted_content>\n<pasted_content id=\"2\">second part</pasted_content>"
        ));
        assert!(!echo.matches("Continue work historical context Keep the transcript unchanged."));
        assert!(!echo.matches(&format!("{text} extra instructions")));
        assert!(!echo.matches(&format!("<pasted_content id=\"1\">{text}")));
        assert!(!ComposerEcho::new(text.clone(), 1).matches(&format!("<pasted_content>{text}</pasted_content>")));
    }

    /// One echo the transcript never produces must not shift every later
    /// comparison by one: a match further back drains the misses ahead of it,
    /// and the next send drops anything that has waited past the TTL.
    #[test]
    fn missed_composer_echo_does_not_poison_later_matches() {
        let mut pending = std::collections::VecDeque::new();
        pending.push_back(ComposerEcho::new("first".into(), 0));
        pending.push_back(ComposerEcho::new("second".into(), 0));
        let user = |text: &str| Payload::UserMessage { author: None, text: text.into(), images: Vec::new(), baseline: None, queued: false, cwd: None };

        assert!(consume_composer_echo(&mut pending, &user("typed in the pane")).is_none());
        assert_eq!(pending.len(), 2);
        assert!(consume_composer_echo(&mut pending, &user("second")).is_some());
        assert!(pending.is_empty(), "the missed echo ahead of the match is dropped with it");

        // The clock is moved forward rather than a send-time backward: an
        // `Instant` cannot go before the monotonic clock's origin, and a
        // freshly booted runner may not have two minutes behind it.
        let sent = Instant::now();
        let later = sent + COMPOSER_ECHO_TTL + std::time::Duration::from_secs(1);
        pending.push_back(ComposerEcho { sent_at: sent, ..ComposerEcho::new("stale".into(), 0) });
        pending.push_back(ComposerEcho { sent_at: later, ..ComposerEcho::new("fresh".into(), 0) });
        expire_composer_echoes(&mut pending, false, later);
        assert_eq!(pending.len(), 1);
        assert!(consume_composer_echo(&mut pending, &user("fresh")).is_some());

        // Nothing ages while a turn runs: the CLI may record a prompt long
        // after it was sent, and an echo dropped early would let that record
        // through as a second message.
        pending.push_back(ComposerEcho { sent_at: sent, ..ComposerEcho::new("recorded late".into(), 0) });
        pending.push_back(ComposerEcho { sent_at: sent, queued: true, ..ComposerEcho::new("held".into(), 0) });
        expire_composer_echoes(&mut pending, true, later);
        assert_eq!(pending.len(), 2, "the turn is still running");
        assert!(consume_composer_echo(&mut pending, &user("recorded late")).is_some());

        // Once the turn is over a held prompt is taken at once or not at
        // all, so its echo does not linger to swallow the same words typed
        // into the terminal.
        expire_composer_echoes(&mut pending, false, later + QUEUED_ECHO_GRACE);
        assert_eq!(pending.len(), 1, "the wait is counted from when the turn was last seen running");
        expire_composer_echoes(&mut pending, false, later + QUEUED_ECHO_GRACE + std::time::Duration::from_secs(1));
        assert!(pending.is_empty());
    }

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
