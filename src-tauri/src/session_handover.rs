//! A runtime's agent tabs, handed to the runtime that replaces it (#765).
//!
//! The processes go over with the runtime's process itself: an agent's CLI
//! runs in a terminal the handover carries (`pty::handover`), and its hooks
//! dial a socket that goes on listening (`hooks::Bridge`). What goes over here
//! is what the runtime knows of each tab: how far its transcript has been
//! read, the turn it has open, the prompts waiting for it, the cards waiting
//! on someone, and how far the chat's log has got. With that, the runtime
//! that takes over follows each CLI on from exactly where this one stopped.
//!
//! The tabs are held still while they are read, and stay held until this
//! process is the new runtime: no prompt is being typed, no transcript read
//! and no tab changed in between. What is about to settle (a CLI starting or
//! stopping, a prompt on its way into a CLI) is waited for. What this format
//! cannot carry, an agent driven over its standard input and output, is
//! named, for the reader to be asked about.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::retire::{Work, WorkKind};
use super::*;

/// Milliseconds since `at`.
fn ago(at: Instant) -> u64 {
    u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// The moment `ms` before now.
fn back(ms: u64) -> Instant {
    let now = Instant::now();
    now.checked_sub(Duration::from_millis(ms)).unwrap_or(now)
}

/// Milliseconds from now until `at`, negative once it has passed.
fn until(at: Instant) -> i64 {
    let now = Instant::now();
    match at.checked_duration_since(now) {
        Some(left) => i64::try_from(left.as_millis()).unwrap_or(i64::MAX),
        None => -i64::try_from(now.duration_since(at).as_millis()).unwrap_or(i64::MAX),
    }
}

/// The moment `ms` from now, or before now when negative.
fn at(ms: i64) -> Instant {
    if ms >= 0 { Instant::now() + Duration::from_millis(ms.unsigned_abs()) } else { back(ms.unsigned_abs()) }
}

/// One agent tab as it is handed over.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TabRecord {
    pub session_id: String,
    pub tab_id: String,
    pub harness: String,
    /// The sequence number of the tab's last event, published or not.
    pub seq: u64,
    pub status: TabStatus,
    #[serde(default)]
    pub pending: Vec<AskRecord>,
    #[serde(default)]
    pub queued: Vec<QueuedMessage>,
    #[serde(default)]
    pub turn_open: bool,
    #[serde(default)]
    pub turn_opener: Option<(String, String)>,
    #[serde(default)]
    pub turn_by_command: bool,
    #[serde(default)]
    pub signed_out_in_turn: bool,
    #[serde(default)]
    pub compact_completed: bool,
    #[serde(default)]
    pub compact_boundary_at: Option<String>,
    #[serde(default)]
    pub turn_started_ms: Option<u64>,
    #[serde(default)]
    pub last_activity_ms: u64,
    #[serde(default)]
    pub recovery: Option<RecoveryKind>,
    #[serde(default)]
    pub stalled_ms: Option<u64>,
    #[serde(default)]
    pub reported_mode_to_judge: Option<String>,
    #[serde(default)]
    pub message_times: HashMap<String, String>,
    /// Where a CLI the tab no longer has, or one started by hand in its
    /// terminal, had been read to: one started by hand is followed on from
    /// there once the new runtime finds it in front of its terminal again.
    #[serde(default)]
    pub left_at: Option<(PathBuf, u64)>,
    /// The app's own CLI in the tab's terminal, when it is running.
    #[serde(default)]
    pub cli: Option<CliRecord>,
}

/// A permission or question card waiting on someone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskRecord {
    pub request_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: Value,
    #[serde(default)]
    pub suggestions: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_command: Option<String>,
}

/// The app's CLI in a tab, as the tab drives it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliRecord {
    /// `claude` or `codex`.
    pub kind: String,
    pub mode: String,
    pub pane_id: String,
    pub launched_ms: u64,
    #[serde(default)]
    pub restart_when_idle: bool,
    #[serde(default)]
    pub settings_asked_ms: Option<u64>,
    #[serde(default)]
    pub launched_for: Option<Settings>,
    #[serde(default)]
    pub status_names_model: bool,
    #[serde(default)]
    pub settings_command_is_ours: bool,
    pub announces_start: bool,
    /// How long ago the CLI said it was up, once it has.
    #[serde(default)]
    pub ready_ms: Option<u64>,
    #[serde(default)]
    pub recorded: bool,
    pub tail: TailRecord,
    #[serde(default)]
    pub echoed: Vec<EchoRecord>,
    #[serde(default)]
    pub held: Vec<u64>,
    #[serde(default)]
    pub prompts: Vec<PromptRecord>,
    #[serde(default)]
    pub input: InputRecord,
    #[serde(default)]
    pub resend_after_abort: Option<u64>,
    #[serde(default)]
    pub codex_interrupt_hooks_owed: usize,
    #[serde(default)]
    pub codex_prompt_starts_turn: bool,
    #[serde(default)]
    pub awaiting_delivery: Option<u64>,
    #[serde(default)]
    pub delivery_sent_ms: Option<u64>,
    /// Milliseconds until the deadline, negative once it has passed.
    #[serde(default)]
    pub accept_in_ms: Option<i64>,
    #[serde(default)]
    pub nudge_in_ms: Option<i64>,
    #[serde(default)]
    pub nudges_left: u32,
    #[serde(default)]
    pub entered_ms: Option<u64>,
    /// The cards a hook of this CLI waits on, with the hook's name.
    #[serde(default)]
    pub decisions: Vec<(String, String)>,
    #[serde(default)]
    pub turn_tail: TurnTailRecord,
    #[serde(default)]
    pub transcript_turn: Option<String>,
    #[serde(default)]
    pub transcript_end_owed: bool,
    #[serde(default)]
    pub answered: HashMap<String, bool>,
    pub command: String,
    /// The secret this launch's hooks show, and where its transcript may be.
    pub token: String,
    pub transcript_root: PathBuf,
    #[serde(default)]
    pub conversation: Option<crate::hooks::ConversationFile>,
}

/// Where a transcript has been read to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TailRecord {
    /// Empty while the CLI has yet to say which file it writes (Codex).
    pub path: PathBuf,
    /// How far every complete record has been read.
    pub offset: u64,
    /// Where reading the file began: what came before is not this CLI's.
    pub began: u64,
    #[serde(default)]
    pub carried: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EchoRecord {
    pub text: String,
    pub image_count: usize,
    pub sent_ms: u64,
    pub typing: bool,
    pub submitted: bool,
    pub queued: bool,
    pub command: bool,
    pub seq: u64,
    pub overtaken: bool,
    pub continuation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptRecord {
    pub uuid: String,
    pub parent: Option<String>,
    pub seq: u64,
    pub text: String,
    pub worked_on: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputRecord {
    pub waiting: bool,
    pub marks: Vec<u64>,
    pub made_waiting: bool,
    pub stops: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnTailRecord {
    pub said: Option<String>,
    pub anticipated: Vec<String>,
    pub closed: bool,
}

impl Default for TurnTailRecord {
    fn default() -> Self {
        let (said, anticipated, closed) = tui::TurnTail::default().parts();
        Self { said, anticipated, closed }
    }
}

/// A card a handed-over hook waits on: the tab, the card, and the hook's name.
pub(crate) struct Wait {
    pub tab: Arc<Mutex<TabRuntime>>,
    pub ask: AskRecord,
    pub gate: String,
}

/// The labels a turn may be opened under, by which a record names them.
const OPENERS: &[&str] = &[
    "session", "hook", "composer", "hook_user_prompt_submit", "transcript_task_started", "transcript_turn_started",
    "transcript_prompt_sent_again", "transcript_queued_prompt", "transcript_user_message",
    "prompt", "slash_command", "compact_command", "pre_tool_use", "post_tool_use",
];

fn label(name: &str) -> Option<&'static str> {
    OPENERS.iter().copied().find(|known| *known == name)
}

fn mark_name(mark: tui::TurnMark) -> &'static str {
    match mark {
        tui::TurnMark::Opened => "opened",
        tui::TurnMark::Ended => "ended",
        tui::TurnMark::Aborted => "aborted",
    }
}

fn mark_of(name: &str) -> Option<tui::TurnMark> {
    match name {
        "opened" => Some(tui::TurnMark::Opened),
        "ended" => Some(tui::TurnMark::Ended),
        "aborted" => Some(tui::TurnMark::Aborted),
        _ => None,
    }
}

fn kind_name(kind: CliKind) -> &'static str {
    match kind {
        CliKind::Claude => "claude",
        CliKind::Codex => "codex",
    }
}

/// The CLIs a record of this format may name.
pub(crate) fn cli_kind(name: &str) -> Option<CliKind> {
    match name {
        "claude" => Some(CliKind::Claude),
        "codex" => Some(CliKind::Codex),
        _ => None,
    }
}

/// Every agent tab, read while each is held still.
pub(crate) struct Held {
    pub tabs: Vec<TabRecord>,
    /// What this format cannot carry, which goes only if it is stopped first.
    pub unadoptable: Vec<Work>,
    /// The cards a hook waits on, in every tab, by request id. A card is
    /// answered or withdrawn only under its tab's lock, by taking its sender
    /// from the tab, so a hook parked on a card not among these has been
    /// answered, and has yet to wake (`hooks::Bridge::take`).
    pub awaited: HashSet<String>,
}

/// What keeps a handover waiting: something about to settle.
#[derive(Debug)]
pub(crate) struct Unsettled(pub String);

impl std::fmt::Display for Unsettled {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.0)
    }
}

impl std::error::Error for Unsettled {}

/// How often a lock some other work holds is tried again.
const RETRY: Duration = Duration::from_millis(10);
/// How long the tabs are given to say what a handover cannot carry.
const PLAN_WITHIN: Duration = Duration::from_secs(2);

/// `lock` as soon as it is free, until `deadline`: never waiting on it, since
/// whoever holds it may be waiting on something this already holds.
fn take<'a, T>(lock: &'a Mutex<T>, deadline: Instant, what: &str) -> Result<MutexGuard<'a, T>> {
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(RETRY),
            Err(std::sync::TryLockError::WouldBlock) => return Err(Unsettled(format!("{what} is busy")).into()),
        }
    }
}

impl SessionManager {
    /// The agents this format cannot hand over now, by name: one driven over
    /// its standard input and output, while its process runs. Read without
    /// holding anything, to ask about before a handover begins.
    pub(crate) fn unadoptable(&self) -> Vec<Work> {
        let tabs: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        // A tab held up elsewhere is not waited on for long: the handover
        // itself finds out whether it comes to rest.
        let deadline = Instant::now() + PLAN_WITHIN;
        tabs.iter().filter_map(|tab| Self::unadoptable_tab(&*take(tab, deadline, "An agent tab").ok()?)).collect()
    }

    fn unadoptable_tab(rt: &TabRuntime) -> Option<Work> {
        match &rt.engine {
            Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_) if rt.child_pid.is_some_and(crate::harness::host::is_alive) => {
                let kind = if rt.turn_open || matches!(rt.status, TabStatus::InProgress | TabStatus::Waiting) { WorkKind::Turn } else { WorkKind::Processes };
                Some(Work { kind, session_id: Some(rt.session_id.clone()), tab_id: Some(rt.tab_id.clone()), harness: Some(rt.harness.clone()), title: None })
            }
            _ => None,
        }
    }

    /// Hold every tab still, read each, and give `then` what was read; the
    /// tabs stay held until `then` returns, which in a handover it does not.
    /// Nothing is held for longer than `within` waiting for the rest: what
    /// is about to settle fails with [`Unsettled`], to be tried again.
    pub(crate) fn hold_tabs<R>(&self, within: Duration, then: impl FnOnce(Held) -> R) -> Result<R> {
        let deadline = Instant::now() + within;
        let mut runtimes: Vec<(String, Arc<Mutex<TabRuntime>>)> = self.tabs.lock().unwrap().iter().map(|(key, rt)| (key.clone(), rt.clone())).collect();
        runtimes.sort_by(|a, b| a.0.cmp(&b.0));
        let writers: Vec<Arc<PaneWriter>> = self.writers.lock().unwrap().values().cloned().collect();
        // Whoever types into a pane holds its writer and then its tab, so
        // the writers come first; then each transcript reader, which holds
        // its tail and then its tab; then the tabs.
        let mut typing = Vec::with_capacity(writers.len());
        for writer in &writers {
            typing.push(take(&writer.typing, deadline, "A prompt being typed into an agent")?);
        }
        let mut tails: Vec<Arc<tui::Tail>> = Vec::new();
        for (_, rt) in &runtimes {
            if let Engine::Cli(p) = &take(rt, deadline, "An agent tab")?.engine {
                tails.push(p.tail.clone());
            }
        }
        let mut reading = Vec::with_capacity(tails.len());
        for tail in &tails {
            reading.push(take(&tail.application, deadline, "An agent's transcript")?);
        }
        let mut held = Vec::with_capacity(runtimes.len());
        for (_, rt) in &runtimes {
            held.push(take(rt, deadline, "An agent tab")?);
        }
        // A CLI started or restarted between reading the tails and holding
        // the tabs follows a tail that is not held.
        let unheld = held.iter().any(|rt| matches!(&rt.engine, Engine::Cli(p) if !tails.iter().any(|tail| Arc::ptr_eq(tail, &p.tail))));
        if unheld {
            return Err(Unsettled("An agent was starting".into()).into());
        }
        // A prompt handed a place in a pane's line before its writer was
        // held would be typed by a thread that does not go over.
        for writer in self.writers.lock().unwrap().values() {
            let turns = writer.turns.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if turns.serving < turns.next {
                return Err(Unsettled("A prompt is on its way into an agent".into()).into());
            }
        }
        if self.mobile.has_pending() {
            return Err(Unsettled("A prompt from a phone is on its way".into()).into());
        }
        // A tab still stopping was refused above. The processes a stop could
        // not confirm gone (`stop_pids`, `session_stop_pids`, kept for good
        // when one ignores its signals) lead process groups the terminals
        // hand over as their own (`pty::Frozen::groups`), which Stop All
        // ends; waiting for them could hold every handover off for good.
        let awaited = held.iter().filter_map(|rt| match &rt.engine {
            Engine::Cli(p) => Some(p.decisions.keys().cloned()),
            _ => None,
        }).flatten().collect();
        let mut records = Vec::new();
        let mut unadoptable = Vec::new();
        for rt in &held {
            if let Some(work) = Self::unadoptable_tab(rt) {
                unadoptable.push(work);
                continue;
            }
            if let Some(record) = self.tab_record(rt)? {
                records.push(record);
            }
        }
        // A tab made meanwhile is one nothing runs in yet: none can start a
        // CLI while the terminals are frozen.
        Ok(then(Held { tabs: records, unadoptable, awaited }))
    }

    /// One held tab as it goes over, or nothing when it holds nothing to
    /// carry. Fails with [`Unsettled`] while it is about to change.
    fn tab_record(&self, rt: &TabRuntime) -> Result<Option<TabRecord>> {
        let name = || format!("{}/{}", rt.session_id, rt.tab_id);
        if rt.stopping || rt.stop_in_flight || rt.restart_claim.is_some() || rt.stdio_starting || !rt.compaction.is_idle() {
            return Err(Unsettled(format!("The agent in {} is starting or stopping", name())).into());
        }
        let mut record = TabRecord {
            session_id: rt.session_id.clone(),
            tab_id: rt.tab_id.clone(),
            harness: rt.harness.clone(),
            seq: rt.seq,
            status: rt.status,
            pending: rt.pending.iter().map(|(id, ask)| AskRecord {
                request_id: id.clone(), tool_use_id: ask.tool_use_id.clone(), tool_name: ask.tool_name.clone(), input: ask.input.clone(), suggestions: ask.suggestions.clone(),
                session_command: match &rt.engine {
                    Engine::Cli(p) => p.decisions.get(id).and_then(|d| d.session_command.clone()),
                    _ => None,
                },
            }).collect(),
            queued: rt.queued.clone(),
            turn_open: rt.turn_open,
            turn_opener: rt.turn_opener.map(|(source, kind)| (source.to_string(), kind.to_string())),
            turn_by_command: rt.turn_by_command,
            signed_out_in_turn: rt.signed_out_in_turn,
            compact_completed: rt.compact_completed,
            compact_boundary_at: rt.compact_boundary_at.map(|at| at.to_rfc3339()),
            turn_started_ms: rt.turn_started_at.map(ago),
            last_activity_ms: ago(rt.last_activity),
            recovery: rt.recovery,
            stalled_ms: rt.stalled_at.map(ago),
            reported_mode_to_judge: rt.reported_mode_to_judge.clone(),
            message_times: rt.message_times.clone(),
            left_at: rt.left_at.clone(),
            cli: None,
        };
        let Engine::Cli(p) = &rt.engine else {
            // Nothing runs for it: only what is waiting goes over.
            let waiting = !record.queued.is_empty() || record.left_at.is_some();
            return Ok(waiting.then_some(record));
        };
        let (path, offset, began, carried) = p.tail.position();
        if p.by_hand.is_some() {
            // The reader's own CLI runs in a terminal that goes over as it
            // is; the runtime that takes over finds it there again.
            record.left_at = (!path.as_os_str().is_empty()).then_some((path, offset));
            return Ok(Some(record));
        }
        if !self.terminals.is_running(&p.pane_id) {
            return Ok(Some(record));
        }
        let (said, anticipated, closed) = p.turn_tail.parts();
        record.cli = Some(CliRecord {
            kind: kind_name(p.harness).into(),
            mode: p.mode.clone(),
            pane_id: p.pane_id.clone(),
            launched_ms: ago(p.launched_at),
            restart_when_idle: p.restart_when_idle,
            settings_asked_ms: p.settings_asked_at.map(ago),
            launched_for: p.launched_for.clone(),
            status_names_model: p.status_names_model,
            settings_command_is_ours: p.settings_command_is_ours,
            announces_start: p.ready.announces_start(),
            ready_ms: p.ready.since().map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX)),
            recorded: p.recorded,
            tail: TailRecord { path, offset, began, carried: carried.into_iter().collect() },
            echoed: p.echoed.iter().map(|echo| EchoRecord {
                text: echo.text.clone(), image_count: echo.image_count, sent_ms: ago(echo.sent_at), typing: echo.typing, submitted: echo.submitted,
                queued: echo.queued, command: echo.command, seq: echo.seq, overtaken: echo.overtaken, continuation: echo.continuation,
            }).collect(),
            held: p.held.clone(),
            prompts: p.prompts.0.iter().map(|prompt| PromptRecord {
                uuid: prompt.lineage.uuid.clone(), parent: prompt.lineage.parent.clone(), seq: prompt.seq, text: prompt.text.clone(), worked_on: prompt.worked_on,
            }).collect(),
            input: InputRecord { waiting: p.input.waiting, marks: p.input.marks.clone(), made_waiting: p.input.made_waiting, stops: p.input.stops },
            resend_after_abort: p.resend_after_abort,
            codex_interrupt_hooks_owed: p.codex_interrupt_hooks_owed,
            codex_prompt_starts_turn: p.codex_prompt_starts_turn,
            awaiting_delivery: p.awaiting_delivery,
            delivery_sent_ms: p.delivery_sent_at.map(ago),
            accept_in_ms: p.accept_by.map(until),
            nudge_in_ms: p.nudge_by.map(until),
            nudges_left: p.nudges_left,
            entered_ms: p.entered_at.map(ago),
            decisions: p.decisions.iter().map(|(id, sender)| (id.clone(), sender.gate.clone())).collect(),
            turn_tail: TurnTailRecord { said, anticipated, closed },
            transcript_turn: p.transcript_turn.map(|mark| mark_name(mark).to_string()),
            transcript_end_owed: p.transcript_end_owed,
            answered: p.answered.clone(),
            command: p.command.clone(),
            token: p.origin.token.clone(),
            transcript_root: p.origin.transcript_root.clone(),
            conversation: p.origin.conversation.clone(),
        });
        Ok(Some(record))
    }

    /// Take over a tab the runtime this one replaced handed over, before
    /// anything is served: its CLI goes on in its terminal (already adopted),
    /// followed from where the record says. Returns the cards the CLI's
    /// hooks wait on, for their waits to go on here ([`Self::resume_decision`]).
    pub(crate) fn adopt_tab(&self, record: TabRecord) -> Result<Vec<Wait>> {
        let rt_arc = self.runtime(&record.session_id, &record.tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        rt.seq = rt.seq.max(record.seq);
        rt.status = record.status;
        rt.pending = record.pending.iter().map(|ask| (ask.request_id.clone(), PendingAsk {
            tool_use_id: ask.tool_use_id.clone(), tool_name: ask.tool_name.clone(), input: ask.input.clone(), suggestions: ask.suggestions.clone(),
        })).collect();
        rt.queued = record.queued;
        rt.turn_open = record.turn_open;
        rt.turn_opener = record.turn_opener.as_ref().and_then(|(source, kind)| Some((label(source)?, label(kind)?)));
        rt.turn_by_command = record.turn_by_command;
        rt.signed_out_in_turn = record.signed_out_in_turn;
        rt.compact_completed = record.compact_completed;
        rt.compact_boundary_at = record.compact_boundary_at.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok());
        rt.turn_started_at = record.turn_started_ms.map(back);
        rt.last_activity = back(record.last_activity_ms);
        rt.recovery = record.recovery;
        rt.stalled_at = record.stalled_ms.map(back);
        rt.reported_mode_to_judge = record.reported_mode_to_judge;
        rt.message_times = record.message_times;
        rt.left_at = record.left_at;
        let Some(cli) = record.cli else { return Ok(Vec::new()) };
        let kind = cli_kind(&cli.kind).with_context(|| format!("no CLI called {}", cli.kind))?;
        anyhow::ensure!(self.terminals.is_live(&cli.pane_id), "its terminal {} was not handed over", cli.pane_id);
        let (decode, marker) = follow::decoders(kind);
        let tail = Arc::new(tui::Tail::resumed(cli.tail.path, cli.tail.offset, cli.tail.began, decode, cli.tail.carried.into_iter().collect::<HashSet<_>>()).marking(marker));
        // Read on from where its CLI began: what the CLI started in the
        // background since is found again (#696).
        rt.background = (kind == CliKind::Claude).then(|| Arc::new(Mutex::new(claude::background::Watch::new(tail.clone()))));
        let generation = self.starts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let pane = cli.pane_id.clone();
        let asks: HashMap<String, AskRecord> = record.pending.into_iter().map(|ask| (ask.request_id.clone(), ask)).collect();
        let decisions: Vec<(AskRecord, String)> = cli.decisions.iter().filter_map(|(id, gate)| Some((asks.get(id)?.clone(), gate.clone()))).collect();
        rt.engine = Engine::Cli(CliTab {
            usage_account: (kind == CliKind::Claude).then(crate::status::usage::claude_account_identity).flatten(),
            harness: kind,
            mode: cli.mode,
            pane_id: cli.pane_id,
            generation,
            launched_at: back(cli.launched_ms),
            restart_when_idle: cli.restart_when_idle,
            settings_asked_at: cli.settings_asked_ms.map(back),
            launched_for: cli.launched_for,
            status_names_model: cli.status_names_model,
            settings_command_is_ours: cli.settings_command_is_ours,
            ready: Arc::new(tui::Ready::restored(cli.announces_start, cli.ready_ms.map(Duration::from_millis))),
            recorded: cli.recorded,
            tail: tail.clone(),
            echoed: cli.echoed.into_iter().map(|echo| ComposerEcho {
                text: echo.text, image_count: echo.image_count, sent_at: back(echo.sent_ms), receipt: None, typing: echo.typing, submitted: echo.submitted,
                queued: echo.queued, command: echo.command, seq: echo.seq, overtaken: echo.overtaken, continuation: echo.continuation,
            }).collect(),
            held: cli.held,
            prompts: RecordedPrompts(cli.prompts.into_iter().map(|prompt| RecordedPrompt {
                lineage: tui::Lineage { uuid: prompt.uuid, parent: prompt.parent }, seq: prompt.seq, text: prompt.text, worked_on: prompt.worked_on,
            }).collect()),
            input: InputBox { waiting: cli.input.waiting, marks: cli.input.marks, made_waiting: cli.input.made_waiting, stops: cli.input.stops },
            resend_after_abort: cli.resend_after_abort,
            codex_interrupt_hooks_owed: cli.codex_interrupt_hooks_owed,
            codex_prompt_starts_turn: cli.codex_prompt_starts_turn,
            awaiting_delivery: cli.awaiting_delivery,
            delivery_sent_at: cli.delivery_sent_ms.map(back),
            accept_by: cli.accept_in_ms.map(at),
            nudge_by: cli.nudge_in_ms.map(at),
            nudges_left: cli.nudges_left,
            entered_at: cli.entered_ms.map(back),
            decisions: HashMap::new(),
            turn_tail: tui::TurnTail::from_parts(cli.turn_tail.said, cli.turn_tail.anticipated, cli.turn_tail.closed),
            transcript_turn: cli.transcript_turn.as_deref().and_then(mark_of),
            transcript_end_owed: cli.transcript_end_owed,
            answered: cli.answered,
            command: cli.command,
            origin: Origin { token: cli.token, transcript_root: cli.transcript_root, conversation: cli.conversation },
            by_hand: None,
        });
        drop(rt);
        self.follow_transcript(&rt_arc, tail, pane, generation);
        Ok(decisions.into_iter().map(|(ask, gate)| Wait { tab: rt_arc.clone(), ask, gate }).collect())
    }

    /// Wait on, here, for the decision a handed-over hook was waiting for,
    /// on the connection that hook still holds open (`stream`), and reply to
    /// it there as it would have been replied to (#765).
    pub(crate) fn resume_decision(&self, bridge: &crate::hooks::Bridge, wait: Wait, stream: std::os::unix::net::UnixStream) {
        let Wait { tab: rt_arc, ask, gate } = wait;
        let (tx, rx) = std::sync::mpsc::channel::<Decision>();
        let local_owner = crate::local_runtime::permissions::enabled();
        let (kind, token, generation) = {
            let mut rt = rt_arc.lock().unwrap();
            let Engine::Cli(p) = &mut rt.engine else { return };
            let caller = match stream.try_clone() {
                Ok(connection) if local_owner => crate::hooks::Caller::of(Arc::new(connection)),
                _ => crate::hooks::Caller::default(),
            };
            let session_command = if p.harness == CliKind::Codex && crate::harness::read_only::explicit_cwd(&ask.input).is_none() { None } else { ask.session_command.clone() };
            p.decisions.insert(ask.request_id.clone(), DecisionSender { sender: tx, caller, gate: gate.clone(), session_command });
            (p.harness, p.origin.token.clone(), p.generation)
        };
        let manager = self.clone();
        bridge.resume(stream, move || {
            let _waiter = if local_owner {
                match crate::local_runtime::permissions::Permit::acquire() {
                    Some(permit) => Some(permit),
                    None => return reply_for(kind, &gate, Decision::Deny),
                }
            } else { None };
            let waiting = Waiting { kind, gate, request_id: ask.request_id, tool_name: ask.tool_name, input: ask.input, local_owner };
            manager.await_decision(&rt_arc, waiting, rx, |rt| matches!(&rt.engine, Engine::Cli(p) if p.generation == generation && p.origin.token == token))
        });
    }
}
