//! Recovery incidents (#815): when a tab's warning was raised, raised again,
//! changed and cleared, and on what evidence; what a window actually showed
//! of it and for how long; what was done about it, by whom and with what
//! result; and what became of the turn. Ordered, versioned lines in one file
//! the runtime keeps under the state home, `diagnostics/recovery-incidents.jsonl`,
//! moved aside to `recovery-incidents.1.jsonl` at [`MAX_BYTES`] (only that
//! one older file is kept).
//!
//! Labels, counts, times and the app's own ids only: never a prompt, code, a
//! tool's input or output, a provider's or an error's own words, a path or a
//! secret. Every field is one of the labels below, a number, or a model or
//! build name cut to [`name`]'s characters. The reader can turn recording off
//! (`settings.json#diagnostics.recoveryIncidents`), clear the files, and
//! export them with sessions and tabs named only by salted hashes.
//!
//! Recording never blocks or fails work: a line that cannot be written is
//! counted, and the next one written says how many were lost before it.
//!
//! What is not seen is not written. A window says what it showed and what
//! the reader pressed; the runtime says what it raised, cleared and admitted.
//! A summary never reads a click or a success into a warning that went away:
//! an incident nothing more is known of is `unresolved` at the end of the log.
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::events::{Payload, TurnStatus};
use crate::recovery::RecoveryKind;

/// The version every line carries. A reader skips lines of a version it does not know.
pub const VERSION: u32 = 1;
/// The most one file holds before it is moved aside for a new one.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;
const FILE: &str = "recovery-incidents.jsonl";
const OLDER: &str = "recovery-incidents.1.jsonl";
/// Progress this recent says the agent was at work when a warning was raised.
pub const ACTIVE_WITHIN: Duration = Duration::from_secs(60);
/// The most incident ids a summary group quotes as its evidence.
const EVIDENCE: usize = 20;

/// The folder the incident files are in.
pub fn dir() -> Result<PathBuf> {
    crate::store::ensure_dir(crate::store::root()?.join("diagnostics"))
}

/// What raised a warning: the evidence it stands on, never its words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// The session watcher: no progress on any channel for its stall limit.
    Watcher,
    /// A prompt the agent did not acknowledge in time.
    Delivery,
    /// The agent or its provider reported an error.
    AgentError,
    /// A turn ended failed.
    TurnFailed,
    /// The provider refused a request for its rate or plan limit.
    Limit,
    /// The agent's process or connection ended.
    Connection,
    /// The agent never took the prompt.
    Unsent,
    /// A permission card lapsed.
    PermissionLapsed,
    /// The provider refused the agent's sign-in.
    SignIn,
    /// Restored from the tab's log when it was opened.
    History,
    /// Restored from a runtime that handed the tab over.
    Handover,
    /// A request the app refused to carry out. Not the turn's failure.
    RequestRefused,
}

/// Who or what a send came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// A window's composer: a person pressed Send.
    Composer,
    /// A share's host sending from the window while the session is shared.
    ShareHost,
    /// A paired phone.
    Phone,
    /// A guest on a shared session.
    Share,
    /// A continuation into a new session (a handoff).
    Continuation,
    /// Anything else: the CLI, an automation, a pipeline, the cloud mailbox,
    /// a recovery button's own prompt (its click is recorded as the window's action).
    Programmatic,
}

/// What became of a send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Admission {
    /// The agent was given it, or it was queued for the next turn.
    Admitted,
    Queued,
    /// Refused because a turn was running or a card waited: the turn goes on.
    Busy,
    /// Refused for another reason, said by [`Refusal`].
    Refused,
}

/// Why a send was refused, as a label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    Busy,
    Stopping,
    Restarting,
    LeftTerminal,
    Other,
}

/// What the tab was doing when a line was written, as the runtime knows it.
#[derive(Debug, Clone, Default, Serialize)]
pub struct State {
    pub turn_open: bool,
    pub pending_asks: usize,
    pub queued: usize,
    /// What the tab shows: `in_progress`, `waiting`, `idle`, `completed`.
    pub displayed: &'static str,
    /// The warning, if one is raised.
    pub recovery: Option<RecoveryKind>,
    /// The warning was the watcher's guess.
    pub stalled: bool,
    /// `cli`, `codex_stdio`, `acp`, `opencode` or `none`.
    pub engine: &'static str,
    /// `running`, `starting`, `exited` or `none`.
    pub process: &'static str,
    /// Native Codex's connection: `ready`, `starting`, `failed`, `exited`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<&'static str>,
}

/// The agent a line is about.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    pub harness: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl Agent {
    pub fn new(harness: &str, transport: &str, model: Option<&str>, effort: Option<&str>) -> Self {
        Self { harness: name(harness), transport: name(transport), model: model.map(name).filter(|m| !m.is_empty()), effort: effort.map(name).filter(|e| !e.is_empty()) }
    }
}

/// A model, effort, harness or build name as a line keeps it: letters,
/// digits and `._:/-` only, at most 64 of them.
pub fn name(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric() || "._:/-".contains(*c)).take(64).collect()
}

/// The tab a line is about, and what it was doing.
pub struct Ctx<'a> {
    pub session: &'a str,
    pub tab: &'a str,
    pub state: State,
}

/// A warning raised in a tab, until it is cleared, and for the rest of its
/// turn after: one raised again there for the same reason is the same
/// incident again, not a new one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Incident {
    pub id: String,
    pub reason: RecoveryKind,
    pub source: Source,
    pub fingerprint: String,
    /// The turn it was raised in (the log seq that opened it), if one was open.
    pub turn: Option<u64>,
    pub occurrences: u32,
    /// The tab log's seq of its first warning event: an error row before it is history.
    #[serde(default)]
    pub first_seq: u64,
    #[serde(skip)]
    raised: Option<Instant>,
    #[serde(skip)]
    cleared: Option<Instant>,
}

/// What a runtime hands the next one of a tab's incidents (`session_handover`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handed {
    pub turn: Option<u64>,
    pub open: Option<Incident>,
    pub last: Option<Incident>,
}

/// A tab's incidents, kept with its runtime.
#[derive(Debug, Default)]
pub struct Tracker {
    /// The log seq of the event that opened the running or last turn.
    turn: Option<u64>,
    turn_open: bool,
    turn_opened: Option<Instant>,
    open: Option<Incident>,
    /// The incident last cleared in this turn.
    last: Option<Incident>,
    /// The last progress the agent showed, and what it was.
    progress: Option<(Instant, &'static str)>,
    agent: Agent,
}

impl Tracker {
    pub fn set_agent(&mut self, agent: Agent) { self.agent = agent; }

    /// A turn is open as the tab's log tells it: a prompt or the agent's
    /// own start, and no end yet.
    pub fn turn_open(&self) -> bool { self.turn_open }

    /// The agent showed it is working: a reply, reasoning, a tool, a request.
    pub fn progress(&mut self, kind: &'static str) { self.progress = Some((Instant::now(), kind)); }

    /// How long since the agent last showed progress, and what it was.
    pub fn last_progress(&self) -> Option<(Duration, &'static str)> { self.progress.map(|(at, kind)| (at.elapsed(), kind)) }

    pub fn turn_started(&mut self, ctx: &Ctx, seq: u64, opener: &'static str) {
        if self.turn_open { return; }
        self.turn = Some(seq);
        self.turn_open = true;
        self.turn_opened = Some(Instant::now());
        // A warning carried into a new turn is still that warning; one only
        // cleared in the last turn is not this turn's to repeat.
        self.last = None;
        write("turn_started", ctx, self, json!({ "opener": opener, "event_seq": seq, "carried": self.open.as_ref().map(|incident| &incident.id) }));
    }

    pub fn turn_ended(&mut self, ctx: &Ctx, seq: u64, status: TurnStatus) {
        if !self.turn_open { return; }
        let incidents: Vec<Value> = self.open.iter().map(|incident| json!({ "incident": incident.id, "state": "open" }))
            .chain(self.last.iter().map(|incident| json!({ "incident": incident.id, "state": "cleared" }))).collect();
        write("turn_ended", ctx, self, json!({
            "status": turn_status(status), "event_seq": seq, "incidents": incidents,
            "duration_ms": self.turn_opened.map(|at| millis(at.elapsed())),
        }));
        self.turn_open = false;
        self.turn_opened = None;
    }

    /// `seq`: the warning's own event in the tab's log.
    pub fn raised(&mut self, ctx: &Ctx, reason: RecoveryKind, source: Source, seq: u64) {
        let fingerprint = fingerprint(reason, source, &self.agent);
        let now = Instant::now();
        let turn = self.turn.filter(|_| self.turn_open);
        // The same warning again: while it is still up (a watcher's second
        // look), or after it cleared in this same turn.
        let same = |incident: &Incident| incident.reason == reason && incident.fingerprint == fingerprint && incident.turn == turn;
        let mut line = json!({ "reason": reason, "source": source, "event_seq": seq });
        let mut kind = "recovery_raised";
        let incident = if self.open.as_ref().is_some_and(same) {
            let mut incident = self.open.take().expect("checked above");
            incident.occurrences += 1;
            line["still_raised"] = json!(true);
            incident
        } else {
            if let Some(old) = self.open.take() {
                kind = "recovery_changed";
                line["replaces"] = json!(old.id);
                line["from"] = json!(old.reason);
            }
            if self.last.as_ref().is_some_and(same) {
                let mut incident = self.last.take().expect("checked above");
                line["recurred_after_ms"] = json!(incident.cleared.map(|at| millis(now.saturating_duration_since(at))));
                incident.occurrences += 1;
                incident.cleared = None;
                incident.raised = Some(now);
                incident
            } else {
                line["fingerprint"] = json!(fingerprint);
                Incident { id: uuid::Uuid::now_v7().to_string(), reason, source, fingerprint: fingerprint.clone(), turn, occurrences: 1, first_seq: seq, raised: Some(now), cleared: None }
            }
        };
        line["incident"] = json!(incident.id);
        line["occurrence"] = json!(incident.occurrences);
        self.open = Some(incident);
        write(kind, ctx, self, line);
    }

    /// `cause`: what took the warning down, as the caller saw it
    /// (`progress`, `turn_ended`, `delivery_confirmed`, `stall_disproved`,
    /// `status`). `seq`: the clearing event in the tab's log.
    pub fn cleared(&mut self, ctx: &Ctx, cause: &'static str, seq: u64) {
        let Some(mut incident) = self.open.take() else {
            // A warning this runtime never raised (one an older runtime
            // raised and did not hand over): said, so the log has no gap.
            return write("recovery_cleared", ctx, self, json!({ "incident": Value::Null, "cause": cause, "event_seq": seq }));
        };
        let now = Instant::now();
        incident.cleared = Some(now);
        let latency = incident.raised.map(|at| millis(now.saturating_duration_since(at)));
        let line = json!({ "incident": incident.id, "reason": incident.reason, "cause": cause, "event_seq": seq, "raised_for_ms": latency, "occurrences": incident.occurrences });
        self.last = Some(incident);
        write("recovery_cleared", ctx, self, line);
    }

    /// A send, from wherever it came. `attempt`: the attempt's own id, which
    /// the prompt's later turn is correlated by through `prompt_seq`.
    /// `found`: whether a turn was open and how many cards waited when the
    /// send arrived, before it changed anything; `state` is after.
    pub fn send(&self, ctx: &Ctx, origin: Origin, admission: Admission, refusal: Option<Refusal>, prompt_seq: Option<u64>, found: Option<(bool, usize)>) {
        write("send_attempt", ctx, self, json!({
            "attempt": uuid::Uuid::now_v7().to_string(), "origin": origin, "admission": admission, "refusal": refusal, "prompt_seq": prompt_seq,
            "found": found.map(|(turn_open, pending_asks)| json!({ "turn_open": turn_open, "pending_asks": pending_asks })),
            // A refusal while a turn runs is the request's, never the turn's.
            "turn_failed": false,
        }));
    }

    /// What the runtime that had the tab before handed over.
    pub fn handed(&self) -> Handed { Handed { turn: self.turn.filter(|_| self.turn_open), open: self.open.clone(), last: self.last.clone() } }

    pub fn adopt(&mut self, ctx: &Ctx, handed: Option<Handed>) {
        let Some(handed) = handed else { return };
        self.turn = handed.turn;
        self.turn_open = handed.turn.is_some();
        self.turn_opened = self.turn_open.then(Instant::now);
        let now = Instant::now();
        self.open = handed.open.map(|incident| Incident { raised: Some(now), ..incident });
        self.last = handed.last.map(|incident| Incident { cleared: Some(now), ..incident });
        let open = self.open.as_ref().map(|incident| incident.id.clone());
        write("handed_over", ctx, self, json!({ "incident": open, "turn_open": self.turn_open }));
    }

    /// What a window reported it showed or what was done in it, with the
    /// incident it was about when the runtime knows one.
    /// An error row older than the incident (its `eventSeq` before the
    /// warning's first event) is history: told with no incident.
    pub fn ui(&self, ctx: &Ctx, report: &UiReport) {
        let incident = self.open.iter().chain(self.last.iter())
            .find(|incident| report.reason.is_none_or(|reason| reason == incident.reason) && report.event_seq.is_none_or(|seq| seq >= incident.first_seq))
            .map(|incident| incident.id.clone());
        let mut line = serde_json::to_value(report).unwrap_or(Value::Null);
        // Its kind is the line's (`ui_exposure`, `ui_action`), said below.
        if let Value::Object(fields) = &mut line { fields.remove("kind"); fields.insert("incident".into(), json!(incident)); }
        write(match report.kind { UiKind::Exposure => "ui_exposure", UiKind::Action => "ui_action" }, ctx, self, line);
    }
}

/// One report from a window. Every field is a label or a number: anything
/// else is refused at the boundary, so no text a window holds gets here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiReport {
    pub kind: UiKind,
    pub surface: Surface,
    pub phase: Phase,
    /// The warning on screen, if one was.
    #[serde(default)]
    pub reason: Option<RecoveryKind>,
    /// Pairs a report with its earlier one (shown and hidden, start and result).
    pub client_id: ClientId,
    #[serde(default)]
    pub placement: Option<Placement>,
    /// Whether the tab was the one shown and the window was in front.
    pub active_tab: bool,
    pub foreground: bool,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub hide_reason: Option<HideReason>,
    #[serde(default)]
    pub action: Option<Action>,
    #[serde(default)]
    pub actor: Option<Actor>,
    #[serde(default)]
    pub input: Option<Input>,
    #[serde(default)]
    pub since_exposure_ms: Option<u64>,
    #[serde(default)]
    pub tab_status: Option<DisplayedStatus>,
    #[serde(default)]
    pub result: Option<ActionResult>,
    #[serde(default)]
    pub reject_reason: Option<RejectReason>,
    /// A failed action's error, as the warning it would be classified as.
    #[serde(default)]
    pub error_kind: Option<RecoveryKind>,
    /// The window's clock (ms since the epoch), beside the runtime's.
    #[serde(default)]
    pub at: Option<i64>,
    /// An error row's own event in the tab's log.
    #[serde(default)]
    pub event_seq: Option<u64>,
    /// Where a continuation went (a handoff), by the app's own ids.
    #[serde(default)]
    pub target_session: Option<ClientId>,
    #[serde(default)]
    pub target_tab: Option<ClientId>,
    /// Set by the app, never by the window: its build.
    #[serde(default)]
    pub app_build: Option<String>,
}

impl UiReport {
    /// The report as it is kept: numbers in range, the app's build its own.
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn bounded(mut self, app_build: &str) -> Self {
        const DAY: u64 = 86_400_000;
        self.duration_ms = self.duration_ms.map(|ms| ms.min(DAY));
        self.since_exposure_ms = self.since_exposure_ms.map(|ms| ms.min(DAY));
        self.app_build = Some(name(app_build));
        self
    }
}

/// A window's id for a report pair: 1 to 64 of letters, digits and `-`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClientId(String);
impl<'de> Deserialize<'de> for ClientId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty() || text.len() > 64 || !text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(serde::de::Error::custom("clientId must be 1 to 64 letters, digits or dashes"));
        }
        Ok(Self(text))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiKind { Exposure, Action }

/// Where a warning or an action was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    /// The recovery banner over the composer or the terminal.
    Banner,
    /// A notice in the composer: a refused send, a failed action.
    ComposerNotice,
    /// An error row in the conversation.
    ErrorRow,
    /// The continue-in-a-new-session dialog.
    Dialog,
    /// The chat's own controls (Stop session in the header, Escape).
    Chat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase { Shown, Hidden, Resurfaced, Start, Result }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Placement { Composer, Top }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HideReason {
    /// The warning or notice went away while it was on screen.
    Cleared,
    /// The reader switched to another tab or view.
    TabHidden,
    /// The window went behind another, or was minimised.
    Background,
    /// Scrolled out of view.
    Scrolled,
    /// Its view was closed (the tab, the window).
    Unmounted,
    /// A dialog's own ending: submitted or cancelled.
    Submitted,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Retry,
    ChooseModel,
    ContinueHere,
    Stop,
    ContinueNew,
    Resend,
    SendAgain,
    SignIn,
    Interrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    /// A person, in a window.
    Human,
    /// An agent or the CLI acting on the tab.
    Agent,
    /// The app itself, on no one's say.
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Input { Pointer, Keyboard, Shortcut }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayedStatus { Idle, InProgress, Waiting, Completed }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionResult {
    /// Taken and begun (the start report).
    Accepted,
    /// Not begun: another was running, or the reader may not.
    Rejected,
    /// Finished.
    Ok,
    Failed,
    /// Ended by the reader before it finished (a dialog closed unsent).
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    /// Another recovery was already running (a second, rapid click).
    InProgress,
    /// Someone else holds the tab, or this reader may not act on it.
    Blocked,
    /// The action is not offered for this tab now.
    Unavailable,
}

/// What a failure the agent reported stands on (`recovery::failure`).
pub fn source_of(payload: &Payload) -> Source {
    match payload {
        Payload::TurnCompleted { auth_failed: true, .. } => Source::SignIn,
        Payload::TurnCompleted { .. } => Source::TurnFailed,
        Payload::RateLimited { .. } => Source::Limit,
        _ => Source::AgentError,
    }
}

/// The agent's progress a payload shows, as a label, if it shows any.
pub fn progress_of(payload: &Payload) -> Option<&'static str> {
    use crate::events::Delta;
    Some(match payload {
        Payload::AssistantText { .. } | Payload::Delta(Delta::TextDelta { .. }) => "text",
        Payload::Reasoning { .. } | Payload::Delta(Delta::ThinkingDelta { .. }) => "reasoning",
        Payload::ToolCallStarted { .. } => "tool_started",
        Payload::ToolCallCompleted { .. } => "tool_completed",
        Payload::FileEdits { .. } => "file_edits",
        Payload::ModelRequestStarted => "model_request",
        Payload::TurnStarted { .. } => "turn_started",
        Payload::SubagentStarted { .. } | Payload::SubagentCompleted { .. } => "subagent",
        Payload::ContextCompactionStarted | Payload::ContextCompactionLifecycle { .. } | Payload::ContextCompacted { .. } => "compaction",
        _ => return None,
    })
}

fn turn_status(status: TurnStatus) -> &'static str {
    match status { TurnStatus::Ok => "ok", TurnStatus::Error => "error", TurnStatus::Aborted => "aborted" }
}

/// The same warning, from the same evidence, for the same kind of agent:
/// what recurrence is counted by across turns and tabs.
fn fingerprint(reason: RecoveryKind, source: Source, agent: &Agent) -> String {
    use sha2::Digest;
    let text = format!("{}|{}|{}|{}", label(&reason), label(&source), agent.harness, agent.transport);
    hex(&sha2::Sha256::digest(text.as_bytes())[..8])
}

/// An enum's label as it is written.
fn label<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

fn millis(duration: Duration) -> u64 { u64::try_from(duration.as_millis()).unwrap_or(u64::MAX) }

/// This runtime's start, for monotonic times, and its id, which says which
/// lines those times can be compared across.
fn boot() -> &'static (String, Instant) {
    static BOOT: std::sync::OnceLock<(String, Instant)> = std::sync::OnceLock::new();
    BOOT.get_or_init(|| (uuid::Uuid::now_v7().to_string(), Instant::now()))
}

struct Writer {
    seq: u64,
    /// Lines that could not be written since the last one that was.
    lost: u64,
    /// The settings file's time and what it said, so recording follows a
    /// change the app makes without reading it for every line.
    enabled: Option<(Option<std::time::SystemTime>, PathBuf, bool)>,
}

static WRITER: Mutex<Writer> = Mutex::new(Writer { seq: 0, lost: 0, enabled: None });

/// Whether the reader lets incidents be recorded (on unless turned off).
fn enabled(writer: &mut Writer) -> bool {
    let Ok(path) = crate::store::root().map(|root| root.join("settings.json")) else { return false };
    let modified = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok();
    if let Some((at, known, on)) = &writer.enabled {
        if *known == path && *at == modified { return *on; }
    }
    let on = crate::store::settings::load().diagnostics.recovery_incidents;
    writer.enabled = Some((modified, path, on));
    on
}

fn write(kind: &str, ctx: &Ctx, tracker: &Tracker, fields: Value) {
    // A test that runs a tab outside a scratch home must not write to the
    // reader's own.
    #[cfg(test)]
    if crate::store::state_home_env().is_none() { return; }
    let mut writer = WRITER.lock().unwrap_or_else(|error| error.into_inner());
    if !enabled(&mut writer) { return; }
    writer.seq += 1;
    let (boot_id, started) = boot();
    let progress = tracker.last_progress();
    let mut line = json!({
        "v": VERSION,
        "id": uuid::Uuid::now_v7().to_string(),
        "seq": writer.seq,
        "boot": boot_id,
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "mono_ms": millis(started.elapsed()),
        "runtime": name(env!("CARGO_PKG_VERSION")),
        "kind": kind,
        "session": ctx.session,
        "tab": ctx.tab,
        "turn": tracker.turn.filter(|_| tracker.turn_open),
        "agent": tracker.agent,
        "state": ctx.state,
        "last_progress": progress.map(|(age, kind)| json!({ "kind": kind, "age_ms": millis(age) })),
        "turn_age_ms": tracker.turn_opened.map(|at| millis(at.elapsed())),
    });
    if writer.lost > 0 { line["lost_before"] = json!(writer.lost); }
    if let (Value::Object(line), Value::Object(fields)) = (&mut line, fields) { line.extend(fields); }
    match append(&line.to_string()) {
        Ok(()) => writer.lost = 0,
        Err(error) => {
            writer.lost += 1;
            // Said once per run of failures, not once per line.
            if writer.lost == 1 { log::warn!("record a recovery incident: {error:#}"); }
        }
    }
}

fn append(line: &str) -> Result<()> {
    use std::io::Write;
    let dir = dir()?;
    let path = dir.join(FILE);
    let len = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if len > 0 && len + line.len() as u64 + 1 > MAX_BYTES {
        std::fs::rename(&path, dir.join(OLDER)).context("move the full incident file aside")?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).with_context(|| format!("open {}", path.display()))?;
    writeln!(file, "{line}").context("append an incident line")?;
    Ok(())
}

/// Every line kept, oldest first: the older file, then the current one.
/// A line that is not JSON, or of another version, is left out.
#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // Read by the app's commands; the headless runtime only writes.
pub fn read_all() -> Result<Vec<Value>> {
    let dir = dir()?;
    let mut lines = Vec::new();
    for file in [OLDER, FILE] {
        let Ok(text) = std::fs::read_to_string(dir.join(file)) else { continue };
        lines.extend(text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).filter(|line| line["v"] == VERSION));
    }
    Ok(lines)
}

/// Remove every line kept.
#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // Read by the app's commands; the headless runtime only writes.
pub fn clear() -> Result<()> {
    let dir = dir()?;
    for file in [OLDER, FILE] {
        match std::fs::remove_file(dir.join(file)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error).context("remove an incident file"),
            _ => {}
        }
    }
    Ok(())
}

/// What the log says, for a report: lines with sessions and tabs named by
/// hashes salted for this export alone, and the summary of them.
#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // Read by the app's commands; the headless runtime only writes.
pub fn export(to: &Path) -> Result<()> {
    let lines = pseudonymized(read_all()?, &uuid::Uuid::new_v4().to_string());
    let export = json!({
        "format": "terminalx-recovery-incidents", "version": VERSION,
        "exported_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "summary": summarize(&lines), "lines": lines,
    });
    crate::store::write_json(to, &export)
}

/// `lines` with each session and tab id replaced by a hash salted with
/// `salt`: the same id is the same name within one export, and no export
/// can be joined to another or to the reader's own files.
#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // Read by the app's commands; the headless runtime only writes.
pub fn pseudonymized(mut lines: Vec<Value>, salt: &str) -> Vec<Value> {
    use sha2::Digest;
    let hide = |id: &str| format!("x{}", hex(&sha2::Sha256::digest(format!("{salt}|{id}").as_bytes())[..6]));
    for line in &mut lines {
        for key in ["session", "tab", "targetSession", "targetTab"] {
            if let Some(id) = line[key].as_str().map(hide) { line[key] = json!(id); }
        }
    }
    lines
}

#[derive(Default)]
struct Seen {
    reason: String,
    source: String,
    runtime: String,
    transport: String,
    occurrences: u32,
    raised_ms: Vec<u64>,
    active: bool,
    cleared: Vec<(String, u64)>,
    recurred: u32,
    shown: u32,
    visible_ms: u64,
    actions: Vec<(String, String)>,
    outcome: Option<String>,
    /// Raised by refusing a send while a turn ran (before #815).
    refused_busy: bool,
}

/// Aggregates of `lines` by reason, runtime build and transport, each with
/// its denominators and the incident ids it counts, and the suspected false
/// positives a person should look at. Read from what was recorded only.
#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // Read by the app's commands; the headless runtime only writes.
pub fn summarize(lines: &[Value]) -> Value {
    let mut incidents: BTreeMap<String, Seen> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut sends: BTreeMap<String, u64> = BTreeMap::new();
    let mut busy_while_working = 0u64;
    let mut lost = 0u64;
    // A refusal's error row right before a raise, in the same tab (old builds).
    let mut last_send: HashMap<(String, String), (String, u64)> = HashMap::new();
    for line in lines {
        lost += line["lost_before"].as_u64().unwrap_or(0);
        let kind = line["kind"].as_str().unwrap_or_default();
        let tab = (line["session"].as_str().unwrap_or_default().to_owned(), line["tab"].as_str().unwrap_or_default().to_owned());
        let id = line["incident"].as_str().map(str::to_owned);
        match kind {
            "send_attempt" => {
                let key = format!("{}:{}", line["origin"].as_str().unwrap_or("?"), line["admission"].as_str().unwrap_or("?"));
                *sends.entry(key).or_default() += 1;
                if line["admission"] == "busy" && line["found"]["turn_open"] == true { busy_while_working += 1; }
                last_send.insert(tab.clone(), (line["admission"].as_str().unwrap_or_default().to_owned(), line["mono_ms"].as_u64().unwrap_or(0)));
            }
            "recovery_raised" | "recovery_changed" => {
                let Some(id) = id else { continue };
                if !incidents.contains_key(&id) { order.push(id.clone()); }
                let seen = incidents.entry(id.clone()).or_default();
                seen.reason = line["reason"].as_str().unwrap_or_default().to_owned();
                seen.source = line["source"].as_str().unwrap_or_default().to_owned();
                seen.runtime = line["runtime"].as_str().unwrap_or_default().to_owned();
                seen.transport = line["agent"]["transport"].as_str().unwrap_or_default().to_owned();
                seen.occurrences += 1;
                seen.raised_ms.push(line["mono_ms"].as_u64().unwrap_or(0));
                if line["recurred_after_ms"].is_u64() { seen.recurred += 1; }
                let progress_age = line["last_progress"]["age_ms"].as_u64();
                if line["state"]["turn_open"] == true && progress_age.is_some_and(|age| age < millis(ACTIVE_WITHIN)) { seen.active = true; }
                if seen.source == "request_refused" && last_send.get(&tab).is_some_and(|(admission, _)| admission == "busy") { seen.refused_busy = true; }
            }
            "recovery_cleared" => {
                let Some(seen) = id.and_then(|id| incidents.get_mut(&id)) else { continue };
                seen.cleared.push((line["cause"].as_str().unwrap_or_default().to_owned(), line["raised_for_ms"].as_u64().unwrap_or(0)));
            }
            "ui_exposure" => {
                let Some(seen) = id.and_then(|id| incidents.get_mut(&id)) else { continue };
                match line["phase"].as_str() {
                    Some("shown" | "resurfaced") => seen.shown += 1,
                    Some("hidden") => seen.visible_ms += line["durationMs"].as_u64().unwrap_or(0),
                    _ => {}
                }
            }
            "ui_action" => {
                let Some(seen) = id.and_then(|id| incidents.get_mut(&id)) else { continue };
                seen.actions.push((line["action"].as_str().unwrap_or("?").to_owned(), line["result"].as_str().unwrap_or("?").to_owned()));
            }
            "turn_ended" => {
                let status = line["status"].as_str().unwrap_or("?");
                for entry in line["incidents"].as_array().into_iter().flatten() {
                    let Some(seen) = entry["incident"].as_str().and_then(|id| incidents.get_mut(id)) else { continue };
                    if seen.outcome.is_none() { seen.outcome = Some(format!("turn_{status}")); }
                }
            }
            _ => {}
        }
    }
    let mut groups: BTreeMap<(String, String, String), Vec<&String>> = BTreeMap::new();
    for id in &order {
        let seen = &incidents[id];
        groups.entry((seen.reason.clone(), seen.runtime.clone(), seen.transport.clone())).or_default().push(id);
    }
    let mut suspected = Vec::new();
    let groups: Vec<Value> = groups.into_iter().map(|((reason, runtime, transport), ids)| {
        let seen: Vec<&Seen> = ids.iter().map(|id| &incidents[*id]).collect();
        let mut latencies: Vec<u64> = seen.iter().flat_map(|s| s.cleared.iter().map(|(_, ms)| *ms)).collect();
        latencies.sort_unstable();
        let mut actions: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
        for (action, result) in seen.iter().flat_map(|s| s.actions.iter()) {
            *actions.entry(action.clone()).or_default().entry(result.clone()).or_default() += 1;
        }
        let mut outcomes: BTreeMap<String, u64> = BTreeMap::new();
        for s in &seen { *outcomes.entry(outcome(s)).or_default() += 1; }
        let mut visible: Vec<u64> = seen.iter().filter(|s| s.shown > 0).map(|s| s.visible_ms).collect();
        visible.sort_unstable();
        for (id, s) in ids.iter().zip(&seen) {
            if let Some(why) = suspicion(s) { suspected.push(json!({ "incident": id, "reason": s.reason, "why": why })); }
        }
        json!({
            "reason": reason, "runtime": runtime, "transport": transport,
            "incidents": seen.len(),
            "occurrences": seen.iter().map(|s| u64::from(s.occurrences)).sum::<u64>(),
            "repeats": seen.iter().map(|s| u64::from(s.occurrences.saturating_sub(1))).sum::<u64>(),
            "recurred_after_clearing": seen.iter().map(|s| u64::from(s.recurred)).sum::<u64>(),
            "during_active_work": seen.iter().filter(|s| s.active).count(),
            "visible": { "incidents_shown": visible.len(), "of": seen.len(), "total_ms": visible.iter().sum::<u64>(), "median_ms": percentile(&visible, 50) },
            "actions": actions,
            "with_any_action": seen.iter().filter(|s| !s.actions.is_empty()).count(),
            "cleared": { "count": latencies.len(), "latency_ms": { "median": percentile(&latencies, 50), "p90": percentile(&latencies, 90) } },
            "outcomes": outcomes,
            "evidence": ids.iter().take(EVIDENCE).collect::<Vec<_>>(),
        })
    }).collect();
    let mut sends_value = serde_json::Map::new();
    for (key, count) in sends { sends_value.insert(key, json!(count)); }
    json!({
        "version": VERSION,
        "lines": lines.len(),
        "lines_lost": lost,
        "incidents": order.len(),
        "groups": groups,
        "sends": sends_value,
        "busy_refusals_while_turn_open": busy_while_working,
        "suspected_false_positives": suspected,
    })
}

/// What became of an incident, from what was recorded and nothing else.
fn outcome(seen: &Seen) -> String {
    let acted = seen.actions.iter().any(|(_, result)| result == "ok" || result == "accepted");
    match seen.cleared.last() {
        Some((cause, _)) if !acted => format!("cleared_without_action:{cause}"),
        Some((cause, _)) => format!("cleared_after_action:{cause}"),
        None => seen.outcome.clone().unwrap_or_else(|| "unresolved".into()),
    }
}

/// Why a person should look at an incident as a warning that may not have
/// been owed, if they should.
fn suspicion(seen: &Seen) -> Option<&'static str> {
    if seen.refused_busy { return Some("raised by refusing a send while the turn ran"); }
    let watcher = matches!(seen.reason.as_str(), "timeout" | "delivery_unconfirmed") && matches!(seen.source.as_str(), "watcher" | "delivery");
    if watcher && seen.active { return Some("raised while the agent had shown progress within the last minute"); }
    if watcher && seen.actions.is_empty() && seen.cleared.iter().any(|(cause, _)| cause == "progress") { return Some("cleared by the agent's own progress with no action taken"); }
    None
}

fn percentile(sorted: &[u64], p: usize) -> Option<u64> {
    if sorted.is_empty() { return None; }
    Some(sorted[((sorted.len() - 1) * p).div_ceil(100).min(sorted.len() - 1)])
}

#[cfg(test)]
#[path = "recovery_log_tests.rs"]
mod tests;
