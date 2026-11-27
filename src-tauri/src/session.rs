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
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
#[path = "session_compaction.rs"]
#[allow(dead_code)] // Admission is intentionally not connected to a producer yet.
mod compaction;
#[path = "session_codex_stdio.rs"]
mod codex_stdio;
#[path = "session_view_transition.rs"]
mod view_transition;
#[path = "session_provider_authority.rs"]
#[allow(dead_code)] // Guarded source-only integration; activation still requires acceptance.
pub(crate) mod provider_authority;
pub use view_transition::TerminalViewReport;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::events::*;
use crate::recovery::{self, RecoveryKind};
use crate::harness::host::{Host, LiveChild, Sink, SpawnSpec};
use crate::harness::settings::{self, Apply, Setting, Settings, Signal};
use crate::harness::{acp, claude, codex, opencode, tui, Action, CliKind, HarnessId};
use crate::hooks::{HookFrame, HookReply, Origin};
use crate::store::index::{self, TabEntry, TabStatus};
use crate::sink::{EventSink, SessionObserver};
use crate::{git, pty, store};
use crate::remote::collab::v2::{self as collaboration_v2, Permit as CollaborationPermit};

#[cfg(test)]
static ACP_FULL_PIPE: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);
#[cfg(test)]
static COLLABORATION_PTY_CAPACITY: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

#[path = "session_follow.rs"]
pub mod follow;
#[path = "session_account_switch.rs"]
pub(crate) mod account_switch;
#[path = "session_row_status.rs"]
pub(crate) mod row_status;
#[path = "session_held.rs"]
pub mod held;
#[path = "session_reset.rs"]
mod reset;
pub(crate) use reset::{destination as fork_conversation_destination, fork_conversation, write_forked_conversation};
#[path = "session_unsent.rs"]
mod unsent;
#[path = "session_retire.rs"]
pub(crate) mod retire;
#[cfg(unix)]
#[path = "session_handover.rs"]
pub(crate) mod handover;

/// A guest task's validated desktop binding is exclusive. The optional host
/// container must neither add another desktop nor probe a runtime in the guest.
/// A guest worker's provider gets the guest's own desktop binding and never
/// the host's (`local_vm::guest::launch_config`); any other agent gets what
/// `host` says. Returns the variables to add and the tools.
fn computer_launch(
    guest: crate::cloud_config::LaunchConfig,
    host: impl FnOnce() -> Result<crate::container_vm::VmLaunch>,
) -> Result<(Vec<(String, String)>, crate::container_vm::VmLaunch)> {
    if guest.args.is_empty() {
        return Ok((Vec::new(), host()?));
    }
    Ok((guest.env, crate::container_vm::VmLaunch { args: guest.args, note: None }))
}

/// The one appended prompt a terminal launch of `tab` gives its agent: the
/// workspace's prompts, the desktop tools' note, a sparse checkout's folders
/// and, in a bot's chat, the bot's rules, role and memory as they are now.
/// Refused when what Bots adds makes it longer than one launch can carry
/// (`AppendedPrompt::fits_for_bot`). Only that is (PRO-507): an ordinary
/// session launches as it did before Bots, as does a bot's chat whose
/// workspace prompts were already too long without the bot's note.
pub(crate) fn cli_prompt(entry: &index::SessionEntry, tab: &TabEntry, workspace: Option<&str>, computer: Option<&str>) -> Result<crate::cloud_config::AppendedPrompt> {
    let sparse = crate::sparse_checkout::agent_note(Path::new(&entry.cwd));
    let bot = crate::bots::chat::launch_note(entry, tab);
    let prompt = crate::cloud_config::prompt_args(&tab.harness, &[workspace, computer, sparse.as_deref(), bot.as_deref()]);
    if bot.is_some() && !prompt.fits() && crate::cloud_config::prompt_args(&tab.harness, &[workspace, computer, sparse.as_deref()]).fits() {
        prompt.fits_for_bot()?;
    }
    Ok(prompt)
}

#[derive(Clone)]
pub struct PendingAsk {
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: Value,
    /// Suggestion payloads keyed by option id ("suggest:N").
    pub suggestions: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub session_id: String,
    pub tab_id: String,
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    pub options: Vec<String>,
}

/// What became of a request to stop an agent nothing is using
/// ([`SessionManager::stop_if_idle`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStop {
    /// It sat idle, and its process (with anything it left running) is gone.
    Stopped,
    /// There was no agent process to stop.
    NotRunning,
    /// It is in a turn, or has a prompt waiting: left as it is.
    Busy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Private queue state; public list/cancel responses expose only the message.
/// Handover retains the original ticket, never mints one for remote work.
#[derive(Debug, Clone)]
pub(crate) struct PendingMessage {
    message: QueuedMessage,
    privacy: Option<crate::data_privacy::Ticket>,
    seq: u64,
}

// Keep the Rust literal layout used by native stdio and historical fixtures.
// The wire requirement is non-authorizing; only the native sidecar has permits.
impl Serialize for PendingMessage {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Record<'a> {
            #[serde(flatten)]
            message: &'a QueuedMessage,
            privacy: &'a Option<crate::data_privacy::Ticket>,
            seq: u64,
            provider_authority: provider_authority::QueueRequirement,
        }
        Record { message: &self.message, privacy: &self.privacy, seq: self.seq,
            provider_authority: provider_authority::queue_requirement(&self.message.id) }.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PendingMessage {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Record {
            #[serde(flatten)]
            message: QueuedMessage,
            #[serde(default)]
            privacy: Option<crate::data_privacy::Ticket>,
            #[serde(default)]
            seq: u64,
            #[serde(default)]
            provider_authority: provider_authority::QueueRequirement,
        }
        let mut record = Record::deserialize(deserializer)?;
        record.message.id = provider_authority::restore_queue_id(record.message.id, record.provider_authority);
        Ok(Self { message: record.message, privacy: record.privacy, seq: record.seq })
    }
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
    /// Run a replacement input whose guard enforces the approval's scope.
    Execute(Value),
    Deny,
}

pub(crate) struct DecisionSender {
    sender: std::sync::mpsc::Sender<QueuedDecision>,
    caller: crate::hooks::Caller,
    /// The hook that waits: `PermissionRequest` or `PreToolUse`, which a
    /// handover carries with the wait (#765).
    gate: String,
    /// Exact command and directory offered on this card, never a prefix.
    session_command: Option<String>,
}

struct QueuedDecision {
    decision: Decision,
    mobile: Option<MobileDecision>,
}

struct MobileDecision {
    permit: crate::local_runtime::mobile::WritePermit,
    label: String,
    session_command: String,
}

impl DecisionSender {
    fn send(self, decision: Decision) -> std::result::Result<(), ()> {
        self.queue(QueuedDecision { decision, mobile: None })
    }

    fn queue(self, decision: QueuedDecision) -> std::result::Result<(), ()> {
        if !self.caller.connected() { return Err(()); }
        self.sender.send(decision).map_err(|_| ())
    }
}

/// A permission hook's card, as the hook thread waits on its decision.
struct Waiting {
    kind: CliKind,
    /// `PermissionRequest` or `PreToolUse`: which reply the hook prints.
    gate: String,
    request_id: String,
    local_owner: bool,
}

/// Own the receiver so a timed-out hook stops accepting answers before it
/// waits to reacquire the runtime lock. Only the returned decision resumes work.
fn wait_for_decision<T>(rx: std::sync::mpsc::Receiver<T>, wait: std::time::Duration) -> Option<T> {
    rx.recv_timeout(wait).ok()
}

/// What a PTY-first tab needs to start: the line the pane runs, the
/// transcript to follow, and the conversation id if the app minted one.
struct CliLaunch {
    command: String,
    /// The model the CLI was started on, when that is not the one asked for
    /// (Codex, on an account that cannot run it).
    model: Option<String>,
    tail: tui::Tail,
    minted: Option<String>,
    /// The only directory this launch's hooks may point the tail into.
    transcript_root: PathBuf,
    /// Claude: the conversation's own file, which may be in another folder.
    conversation: Option<crate::hooks::ConversationFile>,
    /// What starting afresh cost, when the conversation had no file to
    /// resume (#663).
    restart: Option<unsent::Restart>,
}

/// The agent account a launch resolved to (#980), from its grant.
#[derive(Debug, Default)]
struct AccountLaunch {
    /// The account: `local`, a key, an added account. `None` in a cloud
    /// workspace, where the workspace's grant decides.
    id: Option<String>,
    /// An added subscription's home: Claude Code's `CLAUDE_CONFIG_DIR`,
    /// Codex's managed `CODEX_HOME`. `None` on This Mac's login or a key.
    home: Option<PathBuf>,
}

impl AccountLaunch {
    fn of(kind: CliKind, grant: &crate::cloud_grants::LaunchGrant) -> Self {
        let variable = match kind {
            CliKind::Claude => crate::agent_keys::home_variable(crate::agent_keys::Agent::Claude),
            CliKind::Codex => crate::agent_keys::home_variable(crate::agent_keys::Agent::Codex),
        };
        let home = grant.after_profile.iter().find(|(name, _)| name == variable).map(|(_, value)| PathBuf::from(value));
        Self { id: grant.account.clone(), home }
    }

    /// Record the launch under `launch` with the account it runs on: as the
    /// agent's default when nothing chose another, so a tab with one login
    /// is counted exactly as before.
    fn record(&self, launch: &str, harness: &str, session_id: &str, tab_id: &str, asked: bool) {
        let default = crate::agent_keys::Agent::of(harness)
            .and_then(|agent| crate::agent_keys::store().and_then(|store| store.entry(agent)).ok())
            .map(|entry| crate::agent_accounts::agent_default(&entry));
        match &self.id {
            Some(id) if asked || default.as_deref() != Some(id.as_str()) => crate::agent_keys::record_launch_on(launch, harness, session_id, tab_id, id),
            _ => crate::agent_keys::record_launch(launch, harness, session_id, tab_id),
        }
    }
}

/// What the CLI's input box allowed, once a prompt could be typed into it.
enum InputWait {
    /// Type now. Says, for the diagnostics, what the box was: `empty`;
    /// `unseen`, with no box on screen to read; or `cleared`, empty after
    /// holding something the prompt waited behind.
    Type(&'static str),
    /// Whoever sent it may no longer write to this tab.
    Revoked,
    /// The CLI it was for has gone, or been replaced.
    Gone,
    /// A command the app types for itself (`/model`, `/effort`), found the
    /// box holding something. It is nobody's message, so nobody would be told
    /// it was waiting: it is not typed at all, and the change is refused.
    Refused,
    /// The reader stopped the turn after this was sent, while the box held
    /// something: it is not typed whenever the box next empties.
    Withdrawn,
}

/// What a tab knows of its CLI's input box (#722).
#[derive(Debug, Default)]
struct InputBox {
    /// A delivery is waiting behind what the box holds.
    waiting: bool,
    /// The messages the chat has been told are waiting on it: the one at the
    /// head of the line, and every one sent and not yet typed behind it.
    marks: Vec<u64>,
    /// The tab was set waiting on the reader for them.
    made_waiting: bool,
    /// What they wait on is a question the CLI drew in place of the box, not
    /// text in it (PRO-462).
    choice: bool,
    /// How many times the reader has stopped the turn from the chat. A
    /// message sent before the latest stop and not yet entered is withdrawn
    /// rather than typed: once the box empties, once the CLI is ready (#746),
    /// or in place of its Enter.
    stops: u64,
    /// A question the CLI drew in its own screen, as the chat was told of it
    /// (PRO-460).
    prompt: ScreenPromptState,
}

/// What the session watcher knows of a question the CLI is stopped on in its
/// own screen (PRO-460).
#[derive(Debug, Default, Clone)]
pub(crate) struct ScreenPromptState {
    /// The question the chat was last told of, if one is up.
    shown: Option<tui::ScreenPrompt>,
    /// The tab's status before the question set it waiting, to go back to.
    was: Option<TabStatus>,
    /// The CLI's input box has been seen since it started: one missing from
    /// then on is something in its place.
    box_seen: bool,
    /// Watcher passes in a row the box was missing with nothing readable in
    /// its place.
    unread_passes: u8,
    /// A question read while the pane was still drawing: shown if the next
    /// pass reads it the same.
    candidate: Option<tui::ScreenPrompt>,
}

/// How the wait for a pane's CLI to listen ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Readiness {
    Cancelled,
    /// The reader stopped the turn before the CLI was ready for the prompt
    /// (#746): a CLI restarted for its settings, still starting.
    Stopped,
    /// It said so, or went quiet on something that is not a known dialog.
    Ready,
    /// Neither signal came in time, or the CLI exited.
    TimedOut,
    /// It is sitting on a first-run screen; the message says which.
    Blocked(&'static str),
}

impl Readiness {
    /// For the delivery diagnostics: which, and never the screen's own text.
    fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Stopped => "stopped",
            Self::Ready => "ready",
            Self::TimedOut => "timed_out",
            Self::Blocked(_) => "blocked",
        }
    }
}

type DeliveryReceipt = std::sync::mpsc::Sender<std::result::Result<(), String>>;

/// A composer prompt waiting for the CLI transcript to echo it. Both CLIs
/// add an `[Image #N]` label per pasted image to the echoed text, so the
/// attachment count is part of the identity even though the composer already
/// published the archived images. Codex writes the labels with a space before
/// the text; Claude Code writes them with nothing in between.
struct ComposerEcho {
    /// A v2 echo restored without its native permit must never be nudged.
    collaboration_required: bool,
    text: String,
    image_count: usize,
    sent_at: Instant,
    receipt: Option<DeliveryReceipt>,
    /// Its typing has begun: some of it may be in the CLI's input box. Until
    /// then a stop has nothing in the CLI to interrupt for it (#746).
    typing: bool,
    /// Enter was written. Confirmation is armed only from then, not while
    /// the prompt is waiting for the CLI to become ready — and a prompt that
    /// was never typed is not one the CLI can be said to have left unsent.
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
    /// The CLI wrote work of its own after this prompt was drawn as the start
    /// of a turn and before it took the prompt (#540). It was busy when the
    /// tab thought it idle — a turn it started itself — and that work was
    /// drawn under a message it had not read. Its echo says where the CLI
    /// did take it.
    overtaken: bool,
    /// Sent with a receipt: a continuation, the whole of a handoff. Its
    /// waiter may give up before the CLI takes it — a handoff left in the
    /// input until the reader presses Enter — and the CLI's record of it is
    /// then the only word the dialog that sent it gets (#662).
    continuation: bool,
}

/// A composer prompt the CLI's record was matched to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Echoed {
    queued: bool,
    seq: u64,
    overtaken: bool,
    continuation: bool,
    /// The record is not the prompt as sent: the prompt is inside it (#722).
    changed: bool,
    /// The record holds this prompt and others, the first of which, at this
    /// `seq`, shows it: the agent received them as one prompt (#722).
    into: Option<u64>,
}

/// How many of the prompts a transcript recorded are kept to tell a
/// replaced one by. A replacement follows the prompt it replaces at once.
const RECORDED_PROMPTS: usize = 32;

/// The prompts the transcript has recorded since this launch began reading
/// it, by where each stands in the conversation (#722).
#[derive(Debug, Default)]
struct RecordedPrompts(std::collections::VecDeque<RecordedPrompt>);

#[derive(Debug)]
struct RecordedPrompt {
    lineage: tui::Lineage,
    /// The chat's `user_message` for it.
    seq: u64,
    text: String,
    /// The agent did work after it: took it up, if not answered it yet.
    worked_on: bool,
}

impl RecordedPrompts {
    /// The prompt one recorded at `lineage` took the place of: an earlier one
    /// that follows the same record, and that the agent did no work on.
    /// Claude Code records that when it drops a turn before answering it,
    /// puts its prompt back in the input box, and is then sent another.
    /// A prompt the agent worked on is not one; a later prompt that follows
    /// the same record is the reader rewinding the conversation, which is
    /// theirs to do. Nor is the first record of a conversation, which follows
    /// nothing.
    ///
    /// Taken out once found: it was replaced once, and a later prompt that
    /// follows the same record again is a rewind past both.
    fn replaced_by(&mut self, lineage: &tui::Lineage) -> Option<RecordedPrompt> {
        lineage.parent.as_ref()?;
        let at = self.0.iter().rposition(|prompt| prompt.lineage.uuid != lineage.uuid && prompt.lineage.parent == lineage.parent && !prompt.worked_on)?;
        self.0.remove(at)
    }

    fn record(&mut self, lineage: tui::Lineage, seq: u64, text: String) {
        if self.0.len() == RECORDED_PROMPTS {
            self.0.pop_front();
        }
        self.0.push_back(RecordedPrompt { lineage, seq, text, worked_on: false });
    }

    /// The agent did something after the newest prompt.
    fn worked_on(&mut self) {
        if let Some(newest) = self.0.back_mut() {
            newest.worked_on = true;
        }
    }
}

/// Whether two prompts say the same, however the CLI wrapped or spaced them.
fn same_words(a: &str, b: &str) -> bool {
    a.split_whitespace().eq(b.split_whitespace())
}

/// How long a composer prompt waits for its echo once no turn is running.
/// Longer than the ready wait, so a slow start is not mistaken for a miss.
const COMPOSER_ECHO_TTL: std::time::Duration = std::time::Duration::from_secs(120);
/// How long a queued prompt waits once the turn it was queued behind is
/// over. A CLI that held it that long takes it at once, so this is short: a
/// queue the CLI discarded must not go on swallowing the same words typed
/// into the terminal.
const QUEUED_ECHO_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// How long a queued prompt whose wait ran out is still known by its words
/// (#1284). A CLI that takes it after all, behind a turn the tab saw end
/// early or a queue it was slow to deliver, is answering that message.
const LAPSED_ECHO_TTL: std::time::Duration = std::time::Duration::from_secs(600);
/// How many lapsed queued prompts are kept to tell a late take by.
const LAPSED_ECHOES: usize = 8;

/// Queued prompts whose echo was given up on (#1284), still owed one. The
/// chat drew each as a Queued card that only the CLI's record of it clears;
/// were that record taken for a prompt typed into the terminal, the card
/// would wait for good beside a second bubble of the same words. Matched
/// only once nothing still awaited does, and only by the whole of its words:
/// the same words typed in the terminal then end the card, which is the
/// message they repeat.
///
/// Each is known only in the conversation it lapsed in (#1335): the
/// transcript file being followed then. A `/clear`, `/resume` or a CLI
/// started by hand moving to another conversation leaves it behind, and
/// that conversation's prompts are its own. Nor does one outlive the same
/// words sent again from the composer: the CLI took that message, and a
/// later prompt with those words typed in the terminal is a third.
#[derive(Default)]
struct LapsedEchoes(std::collections::VecDeque<LapsedEcho>);

struct LapsedEcho {
    at: Instant,
    /// The transcript the tab was following when its wait ran out.
    conversation: PathBuf,
    echo: ComposerEcho,
}

impl LapsedEchoes {
    fn keep(&mut self, echoes: Vec<ComposerEcho>, conversation: &Path, now: Instant) {
        for echo in echoes {
            self.0.push_back(LapsedEcho { at: now, conversation: conversation.to_path_buf(), echo });
        }
        while self.0.len() > LAPSED_ECHOES {
            self.0.pop_front();
        }
    }

    /// Drop those past their time or from another conversation.
    fn prune(&mut self, conversation: &Path, now: Instant) {
        self.0.retain(|lapsed| lapsed.conversation == conversation && now.saturating_duration_since(lapsed.at) <= LAPSED_ECHO_TTL);
    }

    /// The lapsed prompt `payload` records, read from `conversation`, taken
    /// out: the CLI has it.
    fn take(&mut self, payload: &Payload, conversation: &Path, now: Instant) -> Option<Echoed> {
        let Payload::UserMessage { text, .. } = payload else { return None };
        self.prune(conversation, now);
        let at = self.0.iter().position(|lapsed| lapsed.echo.matches(text))?;
        let mut lapsed = self.0.remove(at).expect("the matched echo exists");
        lapsed.echo.confirm_delivery();
        Some(lapsed.echo.echoed())
    }

    /// `recorded` was matched to `sent`, messages the composer sent since,
    /// each its words and how many images it had: the lapsed prompts that
    /// say the same as one of them, or as the record, are not owed that
    /// record, nor any later prompt with those words, and are given up. What
    /// was sent counts as well as the record, which may hold it inside more
    /// or changed (#1385); the record counts as well as what was sent, which
    /// an idle CLI may have recorded as a lapsed prompt's words. Their `seq`s.
    ///
    /// Each may have reached the CLI after all, and its record be the next
    /// with those words, or another's: words alone cannot tell (#1386). The
    /// card is owed a word that its delivery was not confirmed, never a
    /// record that may be a later prompt's.
    fn retire(&mut self, sent: &[(&str, usize)], recorded: &str, conversation: &Path, now: Instant) -> Vec<u64> {
        self.prune(conversation, now);
        let mut retired = Vec::new();
        self.0.retain(|lapsed| {
            let said = lapsed.echo.matches(recorded) || sent.iter().any(|(text, images)| *images == lapsed.echo.image_count && same_words(text, &lapsed.echo.text));
            if said {
                retired.push(lapsed.echo.seq);
            }
            !said
        });
        retired
    }
}

/// How long a CLI is given to answer a `/model` or `/effort` the app typed
/// while it was idle. It answers within a second when it is going to.
const SETTINGS_ANSWER_WAIT: std::time::Duration = std::time::Duration::from_secs(45);

/// How long a continuation's sender waits to hear that the CLI took it.
#[derive(Debug, Clone, Copy)]
struct ReceiptWait {
    /// Past the last Enter written for it, once no nudge is still to come.
    /// A CLI that took the prompt says so within a second.
    after_enter: std::time::Duration,
    /// The whole wait, the CLI's start and the typing included.
    limit: std::time::Duration,
    /// How often the waiter looks at where the prompt has got to.
    poll: std::time::Duration,
}

impl ReceiptWait {
    /// The limit is inside the 120 s the local runtime's client gives the
    /// call carrying this wait, so the dialog is answered, never cut off.
    const DEFAULT: Self = Self {
        after_enter: std::time::Duration::from_secs(20),
        limit: std::time::Duration::from_secs(105),
        poll: std::time::Duration::from_millis(250),
    };
}

/// What a continuation's waiter heard.
#[derive(Debug, PartialEq, Eq)]
enum Receipt {
    Delivered,
    Failed(String),
    /// Nothing, by the time the wait was over.
    Unconfirmed,
}

/// What the pane of a continuation nothing was heard for shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Unconfirmed {
    agent: &'static str,
    /// Input the CLI has yet to read: it is not reading at all.
    unread: usize,
    /// The composer shows the paste: a handoff one Enter from being sent.
    in_input: bool,
}

/// What the sender of a continuation nothing was heard for is told, from
/// what its pane shows. A CLI that is not reading its input was never given
/// the handoff; one whose composer shows it is a handoff one Enter from
/// being sent, which is no failure (#662). Anything else cannot be told
/// apart from a failure, and is reported as one.
fn answer_unconfirmed(seen: Option<Unconfirmed>, mut outcome: SendOutcome) -> Result<SendOutcome> {
    match seen {
        Some(Unconfirmed { agent, unread, .. }) if unread > 0 => Err(anyhow!("The new session opened, but {agent} has stopped reading its input, so the handoff was not sent. Check its terminal before retrying; the prepared prompt is retained.")),
        Some(Unconfirmed { in_input: true, .. }) => {
            outcome.in_input = true;
            Ok(outcome)
        }
        _ => Err(anyhow!("The new session opened, but prompt delivery could not be confirmed. Check its terminal before retrying; the prepared prompt is retained.")),
    }
}

/// What became of an Enter written again for a prompt not yet acknowledged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Nudged {
    /// Written, or the write failed.
    Written(bool),
    /// Another prompt is being typed into the pane; its own Enter is coming.
    Typing,
    /// The CLI is asking something an Enter would answer.
    Asking,
    /// The CLI has this much of its input still to read.
    Unread(usize),
}

/// What an agent is called in a sentence the reader is shown.
fn agent_name(harness: &str) -> &'static str {
    match HarnessId::parse(harness) {
        HarnessId::Claude => "Claude Code",
        HarnessId::Codex => "Codex",
        HarnessId::Acp(_) => "Cursor",
        HarnessId::OpenCode => "OpenCode",
        HarnessId::Other(_) => "The agent",
    }
}

impl ComposerEcho {
    fn new(text: String, image_count: usize) -> Self {
        Self { collaboration_required: false, text, image_count, sent_at: Instant::now(), receipt: None, typing: false, submitted: false, queued: false, command: false, seq: 0, overtaken: false, continuation: false }
    }

    fn echoed(&self) -> Echoed {
        Echoed { queued: self.queued, seq: self.seq, overtaken: self.overtaken, continuation: self.continuation, changed: false, into: None }
    }

    /// Whether this prompt can have reached the CLI inside a prompt it
    /// recorded with more in it (#722): its Enter was written, it has no
    /// images to label, and it is not a command the app typed.
    fn joinable(&self) -> bool {
        self.submitted && !self.command && self.image_count == 0
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
        // A `!` command (#1294): Claude Code runs it in its shell and records
        // the command without the `!`, as `<bash-input>`. The chat turns the
        // `!command` the composer published into the command's block.
        // Only a whole shell record with its input part is one (#1383): the
        // input tags followed by the reader's words are their prompt.
        if let (Some(sent), Some(ran)) = (text.strip_prefix('!'), shell_command(rest)) {
            return ran.split_whitespace().eq(sent.split_whitespace());
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

/// What a composer `!command`'s echo still has to draw (#1294): the output
/// Claude Code recorded with the command, in one record, as a record of its
/// own. The reducer puts it under the `!command` the composer published.
fn shell_output_of_echo(rt: &TabRuntime, payload: &Payload) -> Option<Payload> {
    let Payload::UserMessage { text, cwd, .. } = payload else { return None };
    if rt.harness != "claude" || !claude::transcript::shell_record(text).is_some_and(|shell| shell.input && shell.output) {
        return None;
    }
    let output = text[text.find("</bash-input>")? + "</bash-input>".len()..].trim_start();
    Some(Payload::UserMessage { author: None, bot: None, text: output.to_string(), images: Vec::new(), files: Vec::new(), baseline: None, queued: false, cwd: cwd.clone() })
}

/// The command in a record of Claude Code's `!` shell passthrough (#1294),
/// when `recorded` is one by the shared strict grammar and has an input part
/// (#1383): `<bash-input> git status</bash-input>`, maybe with its output.
fn shell_command(recorded: &str) -> Option<&str> {
    claude::transcript::shell_record(recorded).filter(|shell| shell.input)?;
    bash_input(recorded)
}

/// The text between the first input tags of a shell-shaped record. Only
/// `shell_command` may read it, once the record is known to be one.
fn bash_input(recorded: &str) -> Option<&str> {
    let after = recorded.trim_start().strip_prefix("<bash-input>")?;
    Some(&after[..after.find("</bash-input>")?])
}

/// Peel the run of `[Image #N] [Image #N+1] …` labels off the front of an
/// echoed prompt: how many there were, and the text after them. The labels
/// have to be numbered in order, but not from one: Claude Code counts the
/// images pasted over a whole session, so the twelfth is `[Image #12]`.
/// Anything out of order is prose and stays put.
fn strip_image_labels(mut text: &str) -> (usize, &str) {
    let mut count = 0;
    let mut expected: Option<usize> = None;
    loop {
        let candidate = text.trim_start();
        let Some(after_open) = candidate.strip_prefix("[Image #") else { break };
        let digits = after_open.len() - after_open.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        let Some(rest) = after_open[digits..].strip_prefix(']') else { break };
        let Some(number) = after_open[..digits].parse::<usize>().ok().filter(|n| *n > 0) else { break };
        if expected.is_some_and(|next| next != number) {
            break;
        }
        expected = Some(number + 1);
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
    // The CLI's record holds the paths of the attached files, which its
    // decoder takes off again (`attachments::split_block`), as here.
    let echo = ComposerEcho { collaboration_required: prompt.collaboration.as_ref().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2()), queued, ..ComposerEcho::new(crate::attachments::split_block(&prompt.agent).0, images.len()) };
    let payload = Payload::UserMessage { author: prompt.author.clone(), bot: prompt.bot.clone(), text: prompt.display.clone(), images, files: prompt.files.clone(), baseline, queued, cwd: Some(cwd.to_string()) };
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
    let echoed = pending[at].echoed();
    pending.drain(..=at);
    Some(echoed)
}

/// The composer prompts the CLI recorded inside one prompt with more in it
/// than any of them (#722): each one's words, in order and unbroken, after
/// the one before it. Typed into an input box that held something, they
/// went with it; held by the CLI together, it sent them as one.
///
/// Each reached the agent there and nowhere else will, so each is taken. If
/// the record is nothing but them, one after another, they are shown as they
/// were sent, like a queue any CLI delivers at once. Otherwise the first
/// shows the record, as what the agent received in its place, and the rest
/// are folded into it. A prompt not found is left awaiting: it may be on its
/// way still.
fn consume_composer_echoes_within(pending: &mut std::collections::VecDeque<ComposerEcho>, payload: &Payload) -> Vec<Echoed> {
    let Payload::UserMessage { text, .. } = payload else { return Vec::new() };
    let recorded: Vec<&str> = text.split_whitespace().collect();
    let mut found: Vec<(usize, usize, usize)> = Vec::new();
    let mut from = 0;
    for (at, prompt) in pending.iter().enumerate() {
        if !prompt.joinable() {
            continue;
        }
        let sent: Vec<&str> = prompt.text.split_whitespace().collect();
        if sent.is_empty() || sent.len() > recorded.len() - from {
            continue;
        }
        if let Some(start) = (from..=recorded.len() - sent.len()).find(|start| recorded[*start..start + sent.len()] == sent[..]) {
            found.push((at, start, start + sent.len()));
            from = start + sent.len();
        }
    }
    // One prompt that is the whole record is an echo; `consume_composer_echo`
    // looks for those first.
    if found.is_empty() || (found.len() == 1 && found[0].1 == 0 && found[0].2 == recorded.len()) {
        return Vec::new();
    }
    let queue = found.first().is_some_and(|first| first.1 == 0)
        && found.windows(2).all(|pair| pair[1].1 == pair[0].2)
        && found.last().is_some_and(|last| last.2 == recorded.len());
    let mut taken: Vec<ComposerEcho> = Vec::new();
    for (at, _, _) in found.iter().rev() {
        taken.push(pending.remove(*at).expect("the matched echo exists"));
    }
    taken.reverse();
    let first = taken[0].seq;
    taken
        .into_iter()
        .enumerate()
        .map(|(index, mut prompt)| {
            prompt.confirm_delivery();
            let echoed = prompt.echoed();
            match (queue, index) {
                (true, _) => echoed,
                (false, 0) => Echoed { changed: true, ..echoed },
                (false, _) => Echoed { into: Some(first), ..echoed },
            }
        })
        .collect()
}

/// The prompt just submitted to an idle CLI, recorded as something else
/// (#722): shorter, or edited. An idle CLI records what its input box held
/// when the Enter came, and the first prompt it records after the Enter is
/// that one, as long as it kept at least half of the prompt's words in their
/// order. Anything less alike is a prompt of the reader's own. A queued
/// prompt is never taken this way: the CLI records it later, among others.
fn consume_awaited_echo_changed(pending: &mut std::collections::VecDeque<ComposerEcho>, awaited: Option<u64>, payload: &Payload) -> Option<Echoed> {
    let Payload::UserMessage { text, .. } = payload else { return None };
    let seq = awaited?;
    let at = pending.iter().position(|prompt| prompt.seq == seq)?;
    let prompt = &pending[at];
    if !prompt.submitted || prompt.queued || prompt.command || prompt.overtaken {
        return None;
    }
    let (labels, rest) = strip_image_labels(text);
    if labels != prompt.image_count || !kept_most_of(&prompt.text, rest) {
        return None;
    }
    let mut prompt = pending.remove(at).expect("the matched echo exists");
    prompt.confirm_delivery();
    Some(Echoed { changed: true, ..prompt.echoed() })
}

/// Whether `recorded` keeps at least half of the words of `sent`, in their
/// order: the longest run of them it has, gaps allowed.
fn kept_most_of(sent: &str, recorded: &str) -> bool {
    let sent: Vec<&str> = sent.split_whitespace().collect();
    let recorded: Vec<&str> = recorded.split_whitespace().collect();
    // Past this, comparing costs more than a prompt is worth.
    if sent.is_empty() || sent.len().saturating_mul(recorded.len()) > 4_000_000 {
        return false;
    }
    let mut row = vec![0usize; recorded.len() + 1];
    for word in &sent {
        let mut diagonal = 0;
        for (at, other) in recorded.iter().enumerate() {
            let above = row[at + 1];
            row[at + 1] = if word == other { diagonal + 1 } else { above.max(row[at]) };
            diagonal = above;
        }
    }
    row[recorded.len()] * 2 >= sent.len()
}

/// Codex 0.153.4 joins pending prompts with newlines when Escape delivers
/// its queue. Match a whole contiguous run, never a prefix of the received
/// text, and acknowledge each composer identity once in provider order.
fn consume_codex_queue_echo(pending: &mut std::collections::VecDeque<ComposerEcho>, payload: &Payload) -> Vec<Echoed> {
    let Payload::UserMessage { text, .. } = payload else { return Vec::new() };
    let mut combined = String::new();
    for (at, prompt) in pending.iter().enumerate() {
        // Only the written FIFO prefix can be a provider-owned batch. The
        // captured format proves plain-text joining, not image-label joining.
        if !prompt.queued || !prompt.submitted || prompt.command || prompt.image_count != 0 { break; }
        if at > 0 { combined.push('\n'); }
        combined.push_str(&prompt.text);
        if at > 0 && text == &combined {
            return pending.drain(..=at).map(|mut prompt| {
                prompt.confirm_delivery();
                prompt.echoed()
            }).collect();
        }
    }
    // A single match removes only that identity. Earlier queued messages
    // have not been acknowledged merely because a later record matched.
    let Some(at) = pending.iter().position(|prompt| (prompt.receipt.is_none() || prompt.submitted) && prompt.matches(text)) else { return Vec::new() };
    let mut prompt = pending.remove(at).expect("the matched echo exists");
    prompt.confirm_delivery();
    vec![prompt.echoed()]
}

/// The transcript has work the CLI did before taking any of the composer's
/// prompts still awaited (#540). Those the chat drew as the start of a turn
/// were sent while it was busy — on a turn it started itself, or one the tab
/// missed — and that work was drawn under them. Each is taken later, and its
/// echo is where it starts a turn of its own. A queued one is a note in the
/// turn already, and one held for "Send now" is still the note it was.
fn overtake_composer_prompts(pending: &mut std::collections::VecDeque<ComposerEcho>, held: &[u64]) {
    for prompt in pending.iter_mut().filter(|prompt| !prompt.queued && !prompt.command && !held.contains(&prompt.seq)) {
        prompt.overtaken = true;
    }
}

/// Forget prompts that have waited too long. A prompt the transcript never
/// echoes would otherwise sit at the head of the queue for the life of the
/// tab, and swallow the same words typed into the terminal later.
///
/// Nothing ages while a turn is running. The CLI may record a prompt long
/// after it was sent — a slow start, a queued prompt behind a long turn —
/// and dropping its echo early would draw that record as a second message.
/// The wait is counted from when the turn was last seen running.
///
/// Returns the events of the reader's own queued prompts among them: typed
/// and submitted behind a turn, and still not taken once that turn was over.
/// Those may be sitting in the CLI's input, and the reader is owed a word.
fn expire_composer_echoes(pending: &mut std::collections::VecDeque<ComposerEcho>, turn_open: bool, now: Instant) -> Vec<ComposerEcho> {
    if turn_open {
        for prompt in pending.iter_mut() {
            prompt.sent_at = now;
        }
    }
    let before = pending.len();
    let mut unsent = Vec::new();
    let mut kept = std::collections::VecDeque::with_capacity(pending.len());
    for prompt in pending.drain(..) {
        if !prompt.expired(now) {
            kept.push_back(prompt);
        } else if prompt.queued && prompt.submitted && !prompt.command {
            unsent.push(prompt);
        }
    }
    *pending = kept;
    if pending.len() < before {
        log::warn!("{} composer prompt(s) expired without an echo", before - pending.len());
    }
    unsent
}

/// A prompt is held while its echo is awaited, no longer. Once the echo is
/// in, the CLI has it: sending it "now" would interrupt the turn and type it
/// a second time (#551).
fn forget_taken(cli: &mut CliTab) {
    let awaited = &cli.echoed;
    cli.held.retain(|seq| awaited.iter().any(|echo| echo.seq == *seq));
    if cli.resend_after_abort.is_some_and(|seq| !cli.held.contains(&seq)) {
        cli.resend_after_abort = None;
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
    /// When this CLI was started. One that is gone again within moments,
    /// before it ever said it was up, never got going, and what it printed
    /// is why (#663).
    launched_at: Instant,
    /// A setting the CLI only reads at startup, changed mid-turn. The restart
    /// waits for the turn to end.
    pub restart_when_idle: bool,
    /// When a model or effort change was last typed into this CLI and is
    /// still waiting for it to answer (`harness::settings`). A CLI that never
    /// answers is given up on by the session watcher.
    settings_asked_at: Option<Instant>,
    /// The model and effort this launch was started on because the app asked
    /// for them, until the CLI first says what it is running. If that is
    /// something else, the reader is told the change did not take.
    launched_for: Option<Settings>,
    /// Whether this launch's status line has named its model. Until it has,
    /// the model an assistant record names is the next best word.
    status_names_model: bool,
    /// Whether the last `/model` or `/effort` the transcript recorded was
    /// one the app typed. "Set model to …" names no id, so it only settles
    /// the app's request when it is the answer to the app's own command.
    settings_command_is_ours: bool,
    /// Set when this CLI's `SessionStart` hook arrives; what the thread that
    /// types into the pane waits on.
    pub ready: Arc<tui::Ready>,
    /// Set by the first record this launch's transcript gains. With `ready`,
    /// what says the CLI got past its own startup: until either, an exit
    /// is a failure to start, said with its last line (#667).
    pub recorded: bool,
    pub tail: Arc<tui::Tail>,
    /// Prompts the composer already published, waiting for the transcript to
    /// echo them back so the reader is not shown the same message twice.
    echoed: std::collections::VecDeque<ComposerEcho>,
    /// Queued prompts `echoed` gave up on, which the CLI may take yet (#1284).
    lapsed: LapsedEchoes,
    /// Composer identities still awaiting acceptance from the provider's queue.
    held: Vec<u64>,
    /// The prompts the transcript has recorded, to tell one that took the
    /// place of another by (#722).
    prompts: RecordedPrompts,
    /// What is known of the CLI's input box, and who is waiting on it.
    input: InputBox,
    /// A Send now interrupt already written, awaiting provider acceptance.
    /// Kept as pending work for lifecycle admission; never a resend plan.
    resend_after_abort: Option<u64>,
    /// Transcript aborts already applied, whose Interrupt hooks may arrive late.
    codex_interrupt_hooks_owed: usize,
    /// A task_started awaiting its first user-message record.
    codex_prompt_starts_turn: bool,
    /// The initial composer prompt, until the CLI confirms it through a
    /// transcript echo or turn activity. Startup readiness is not delivery.
    awaiting_delivery: Option<u64>,
    /// When that prompt was sent, for the delivery diagnostics.
    delivery_sent_at: Option<Instant>,
    /// Set once that prompt's Enter is written: when an idle CLI should have
    /// acknowledged it by. Past it the reader is told, rather than left
    /// looking at a message the agent may never have been given (#403).
    accept_by: Option<Instant>,
    /// Set once that prompt's Enter is written, with or without `accept_by`:
    /// when, still unacknowledged, the Enter is written once more, in case
    /// the CLI let the first one go by. A continuation is nudged too; it
    /// only has no deadline here, its receipt being its sender's to judge.
    nudge_by: Option<Instant>,
    /// How many more times that is to happen (`tui::NUDGES`).
    nudges_left: u32,
    /// When that prompt's Enter was last written, the nudges included: what
    /// a continuation's waiter counts its patience from (#662).
    entered_at: Option<Instant>,
    /// Hook threads parked on a decision, by request id.
    pub decisions: HashMap<String, DecisionSender>,
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
    /// What the pane is running, for the terminal view's header and for a
    /// window that has to be told about a pane it did not see start.
    pub command: String,
    /// What this launch's hooks have to prove to be heard: the secret it was
    /// given, and where its transcript is allowed to be.
    pub origin: Origin,
    /// Set when the reader started this CLI by hand in the tab's terminal
    /// (#437) and the app only follows it. Such a CLI was given none of the
    /// app's hooks, so everything a hook would say is read from elsewhere,
    /// and it is never restarted by the app.
    pub by_hand: Option<Box<follow::ByHand>>,
}

/// How long a question drawn in the CLI's screen must have stood still
/// before the chat is told of it (PRO-460): not a frame half drawn.
const SCREEN_PROMPT_QUIET: Duration = Duration::from_millis(500);
/// How long the CLI must have drawn nothing, its input box gone, before
/// that is taken for a question that could not be read.
const SCREEN_PROMPT_UNREAD_QUIET: Duration = Duration::from_secs(2);
/// Between arrow keys answering such a question.
const SCREEN_PROMPT_KEY_GAP: Duration = Duration::from_millis(120);
/// Between the last arrow and Enter: Claude Code 2.1.328 refuses an Enter
/// within 250 ms of an arrow as a stray key.
const SCREEN_PROMPT_CONFIRM_GAP: Duration = Duration::from_millis(500);
/// How long after answering the screen is looked at again.
const SCREEN_PROMPT_SETTLE: Duration = Duration::from_millis(600);

/// How soon after it was started a CLI that goes again never got going.
const STARTUP_EXIT: std::time::Duration = std::time::Duration::from_secs(15);
/// How long after a new tab was added its first start is told apart
/// (PRO-291): the window that opened it watches it that long.
const FIRST_START_WATCH: Duration = Duration::from_secs(10);

/// What a new tab's first start came to (PRO-291).
#[derive(Debug, Clone, PartialEq, Eq)]
enum FirstStart {
    /// Added at this moment, and its agent not known to have gone.
    Starting(Instant),
    /// Its agent exited while starting at this moment: why, for whoever
    /// shows the tab while it is watched.
    Failed(String, Instant),
    /// Its agent went after it got going, or was stopped, at this moment:
    /// nothing failed, and nothing is started again for the window that
    /// asks after the exit.
    Settled(Instant),
}

/// What showing a new tab does about its first start.
#[derive(Debug, PartialEq, Eq)]
enum OnOpen {
    Start,
    Fail(String),
    Leave,
}

/// The new tabs whose first start is still told apart, by `key_of`. Nothing
/// here waits: the agent's exit is recorded as it is let go of, and read
/// back when the window that opened the tab asks again (PRO-291).
#[derive(Default)]
struct FirstStarts(Mutex<HashMap<String, FirstStart>>);

impl FirstStarts {
    fn added(&self, key: String, now: Instant) {
        self.0.lock().unwrap().insert(key, FirstStart::Starting(now));
    }

    fn starting(&self, key: &str) -> bool {
        matches!(self.0.lock().unwrap().get(key), Some(FirstStart::Starting(_)))
    }

    /// Its agent went: `failure` says why when it went while starting and
    /// nobody stopped it. Only the first start, and only while watched.
    fn exited(&self, key: &str, failure: Option<String>, now: Instant) {
        let mut starts = self.0.lock().unwrap();
        let Some(FirstStart::Starting(added)) = starts.get(key) else { return };
        if now.duration_since(*added) >= FIRST_START_WATCH {
            starts.remove(key);
            return;
        }
        let came_to = match failure {
            Some(failure) => FirstStart::Failed(failure, now),
            None => FirstStart::Settled(now),
        };
        starts.insert(key.to_string(), came_to);
    }

    fn on_open(&self, key: &str, now: Instant) -> OnOpen {
        let mut starts = self.0.lock().unwrap();
        match starts.get(key).cloned() {
            // Told to any window that shows it while watched; after that, a
            // tab nobody closed is started again as any other is.
            Some(FirstStart::Failed(failure, at)) if now.duration_since(at) < FIRST_START_WATCH => OnOpen::Fail(failure),
            Some(FirstStart::Failed(..)) => {
                starts.remove(key);
                OnOpen::Start
            }
            Some(FirstStart::Settled(at)) => {
                starts.remove(key);
                if now.duration_since(at) < FIRST_START_WATCH { OnOpen::Leave } else { OnOpen::Start }
            }
            Some(FirstStart::Starting(added)) if now.duration_since(added) >= FIRST_START_WATCH => {
                starts.remove(key);
                OnOpen::Start
            }
            _ => OnOpen::Start,
        }
    }

    fn forget(&self, key: &str) {
        self.0.lock().unwrap().remove(key);
    }
}

impl CliTab {
    /// Forget composer prompts that waited too long for their echo
    /// (`expire_composer_echoes`), keeping the queued ones among them for a
    /// late take (#1284). The `seq`s of those, which the reader is owed a
    /// word about.
    fn expire_echoes(&mut self, turn_open: bool, now: Instant) -> Vec<u64> {
        let unsent = expire_composer_echoes(&mut self.echoed, turn_open, now);
        let seqs = unsent.iter().map(|echo| echo.seq).collect();
        self.lapsed.keep(unsent, &self.tail.path(), now);
        seqs
    }

    /// Whether this CLI went before it ever got going: within moments of the
    /// app starting it, and before it said it was up. What it printed then
    /// is why it went, unlike the last screen of a CLI the reader quit
    /// (#663). One started by hand shares its terminal with the reader's own
    /// shell, which says so there.
    fn never_got_going(&self) -> bool {
        self.by_hand.is_none() && !self.ready.arrived() && self.launched_at.elapsed() < STARTUP_EXIT
    }
}

// One runtime per tab, so the CLI variant's size costs nothing worth a box.
#[allow(clippy::large_enum_variant)]
pub enum Engine {
    Cli(CliTab),
    CodexStdio(codex::stdio::Stdio),
    Acp(acp::Acp),
    OpenCode(opencode::OpenCode),
    None,
}

pub struct TabRuntime {
    pub session_id: String,
    pub tab_id: String,
    /// The bot this tab's session acts for (`bots::chat::acting_bot`), read
    /// from its entry when the runtime is made: fixed for a session's life,
    /// so a bot's gate needs no index read per tool call, and cannot lose
    /// the bot to an index that cannot be read (PRO-478).
    pub(crate) acting_bot: Option<String>,
    /// The bot's built-in duty this tab runs, when it runs one (PRO-477): its
    /// tool calls meet that built-in's allow-list first. Read with `acting_bot`.
    pub(crate) bot_builtin: Option<crate::bots::builtins::Run>,
    pub harness: String,
    pub seq: u64,
    /// Set only while applying a source transcript record; empty means unknown.
    source_timestamp: Option<String>,
    /// First text chunk per block, retained until its committed event is saved.
    message_times: HashMap<String, String>,
    compaction: compaction::Admission,
    stdio_compaction: Option<compaction::Token>,
    stdio_starting: bool,
    setup_failed: bool,
    /// Each frame with the phone or share a prompt came from, if any.
    stdio_writer: Option<std::sync::mpsc::SyncSender<codex_stdio::Delivery>>,
    /// The phone or share the prompt just sent came from, until its frame is
    /// queued with it: it is held to its permits when that frame is written.
    stdio_authority: Option<codex_stdio::Authority>,
    stdio_launch_permit: Option<CollaborationPermit>,
    /// A continuation sent to experimental Codex, answered once Codex takes
    /// its turn or the connection ends before it does.
    stdio_receipt: Option<(u64, DeliveryReceipt)>,
    stdio_followups: codex_stdio::Followups,
    /// The native Codex launch being let go after a turn refused for its
    /// sign-in (`retire_codex_stdio`): until it is gone the tab is busy to
    /// the cloud mailbox, and it keeps showing the refusal.
    stdio_retiring: Option<Arc<()>>,
    pub status: TabStatus,
    pub child: Option<Arc<LiveChild>>,
    pub child_pid: Option<u32>,
    pub environment: crate::store::environment::Stamp,
    pub engine: Engine,
    pub pending: HashMap<String, PendingAsk>,
    pub queued: Vec<PendingMessage>,
    pub held_queue: held::Queue,
    pub turn_open: bool,
    turn_generation: u64,
    automation_completions_in_flight: usize,
    /// Allowlisted labels only; never retain prompt or hook payload text.
    turn_opener: Option<(&'static str, &'static str)>,
    /// A compact boundary observed during this command, not proof a model turn ended.
    compact_completed: bool,
    compact_boundary_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub turn_started_at: Option<Instant>,
    turn_usage: crate::harness::metrics::CompletedUsage,
    /// The open turn is a slash command's, with no work seen yet. The CLI
    /// runs `/help` or `/model` by itself and no `Stop` closes it, so the
    /// next prompt is where that prompt's time starts (`prompt_taken`).
    turn_by_command: bool,
    /// Something in the open turn said the agent's provider refused its
    /// sign-in (#667). Claude Code says so in a record and still ends the
    /// turn with its `Stop` hook, so the end is told here.
    signed_out_in_turn: bool,
    pub last_activity: Instant,
    pub recovery: Option<RecoveryKind>,
    /// The warnings this tab raised and what became of them (#815).
    pub incidents: crate::recovery_log::Tracker,
    /// When the session watcher raised a silence/delivery warning, if it did.
    /// A timeout the provider reported is a different fact and is not
    /// cleared by the terminal drawing again.
    pub stalled_at: Option<Instant>,
    /// The last thing the provider said it was running, so the same word
    /// again (a status line repeats itself) costs nothing. Forgotten whenever
    /// the app asks for a change, since the answer to that must be heard.
    last_settings_report: Option<Signal>,
    /// Raw provider report bound to this exact owned PTY launch.
    collaboration_stance: Option<(Arc<tui::Tail>, settings::Stance)>,
    collaboration_raw: Option<Arc<tui::Tail>>,
    collaboration_prompts: HashMap<u64, CollaborationPermit>,
    collaboration_settings: HashMap<String, CollaborationPermit>,
    /// A mode the provider reported that a shared session may not be in, not
    /// stored yet: whether the session is shared is asked under the sharing
    /// lock, which is taken before this tab's and so not from under it.
    reported_mode_to_judge: Option<String>,
    /// The released launch whose settings restart still owns the empty slot.
    restart_claim: Option<Arc<tui::Tail>>,
    pub stopping: bool,
    pub stop_in_flight: bool,
    pub stopping_pid: Option<u32>,
    /// What the app's Claude CLI in this tab started that it is still waiting
    /// on (a background command, a monitor, a wakeup, a cron job), read from
    /// its transcript when an idle stop is weighed (#696). `None` for any
    /// other agent, and once the CLI is let go of.
    background: Option<Arc<Mutex<claude::background::Watch>>>,
    /// The transcript the tab's last CLI was writing, and how far it had been
    /// read when that CLI was let go of: where to read on from if a CLI is
    /// started on the same conversation by hand (#437).
    left_at: Option<(PathBuf, u64)>,
    /// The checkout's tree, read for the prompt being sent before it was
    /// admitted (#727): `git add -A` walks the whole checkout, which must not
    /// happen with admission or this tab held. Taken by that prompt only.
    prepared_baseline: Option<PreparedBaseline>,
    pub log_path: std::path::PathBuf,
    /// Back-reference so work finished off-thread (an HTTP reply) can re-enter.
    pub me: std::sync::Weak<Mutex<TabRuntime>>,
}

struct CliRestart {
    tail: Arc<tui::Tail>,
    pane: String,
    process: Option<pty::StoppingPane>,
    _privacy: Vec<crate::data_privacy::RemoteWrite>,
}

/// Prevent handover from capturing a closed turn before its automation
/// acknowledgment and durable completion have both been applied.
struct AutomationCompletionGuard(Arc<Mutex<TabRuntime>>);

impl Drop for AutomationCompletionGuard {
    fn drop(&mut self) {
        let mut rt = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        rt.automation_completions_in_flight = rt.automation_completions_in_flight.saturating_sub(1);
    }
}

impl TabRuntime {
    /// A prompt sent now would be queued behind the open turn (and so take
    /// no baseline). A slash command's turn that saw no work is not one.
    fn turn_open_for_prompts(&self) -> bool {
        self.turn_open && !self.turn_by_command
    }

    /// The tree a prompt published now in `cwd` started from: the one read
    /// for it before it was admitted, when that is recent and of the same
    /// folder (#727), else read now.
    fn baseline_for(&mut self, cwd: &str) -> Option<String> {
        match self.prepared_baseline.take() {
            Some(prepared) if prepared.cwd == cwd && prepared.at.elapsed() < PREPARED_BASELINE_FRESH => prepared.tree,
            _ => git::snapshot_tree(Path::new(cwd)).ok(),
        }
    }

    /// A turn opens, starting a fresh activity clock. Whatever the transcript
    /// last said was about a turn before this one, not this one's end.
    fn open_turn(&mut self) {
        if !self.turn_open {
            self.turn_generation = self.turn_generation.saturating_add(1);
            self.turn_by_command = false;
            self.signed_out_in_turn = false;
            self.turn_opener = Some(("session", "prompt"));
            self.compact_completed = false;
            self.compact_boundary_at = None;
        }
        self.turn_open = true;
        self.last_activity = Instant::now();
        if let Engine::Cli(p) = &mut self.engine {
            p.transcript_turn = None;
        }
    }

    /// The CLI has a prompt (possibly a slash command), and a turn is
    /// open. Its clock starts here unless a turn with work in it was already
    /// running: a prompt then is one typed into that turn.
    fn prompt_taken(&mut self, prompt: &str, source: &'static str) {
        // A `!` command (#1294) is run by Claude Code itself, like a bare
        // slash command: no model turn, no Stop. Its output record settles it.
        let command = tui::is_slash_command(prompt) || (self.harness == "claude" && prompt.trim_start().starts_with('!'));
        let compact = self.harness == "claude" && prompt.split_whitespace().next() == Some("/compact");
        let ended = matches!(&self.engine, Engine::Cli(p) if p.transcript_turn.is_some_and(tui::TurnMark::ends));
        let fresh = !self.turn_open || (self.turn_by_command && !command)
            || (compact && (self.turn_by_command || ended));
        let was_open = self.turn_open;
        self.open_turn();
        if fresh {
            if was_open { self.turn_generation = self.turn_generation.saturating_add(1); }
            self.turn_started_at = Some(Instant::now());
            self.turn_by_command = command;
            self.compact_completed = false;
            self.compact_boundary_at = None;
            let kind = if compact { "compact_command" } else if command { "slash_command" } else { "prompt" };
            self.turn_opener = Some((source, kind));
        }
    }

    /// Claude writes the command again after the boundary, but retains the
    /// earlier command timestamp. Missing times cannot prove a duplicate.
    fn repeats_completed_compact(&self, prompt: &str) -> bool {
        self.harness == "claude" && prompt.split_whitespace().next() == Some("/compact") && self.compact_completed
            && self.source_timestamp.as_deref().and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
                .zip(self.compact_boundary_at).is_some_and(|(prompt, boundary)| prompt <= boundary)
    }

    /// Note something about this tab's warnings (#815), with what it is
    /// doing as it is noted.
    fn incident(&mut self, note: impl FnOnce(&mut crate::recovery_log::Tracker, &crate::recovery_log::Ctx)) {
        let state = self.incident_state();
        let ctx = crate::recovery_log::Ctx { session: &self.session_id, tab: &self.tab_id, state };
        note(&mut self.incidents, &ctx);
    }

    /// What the runtime knows of the tab right now, as labels and counts.
    fn incident_state(&self) -> crate::recovery_log::State {
        let (engine, connection) = match &self.engine {
            Engine::Cli(_) => ("cli", None),
            Engine::CodexStdio(e) => ("codex_stdio", Some(if e.failed() { "failed" } else if e.exited || e.blocked { "exited" } else if e.ready { "ready" } else { "starting" })),
            Engine::Acp(_) => ("acp", None),
            Engine::OpenCode(_) => ("opencode", None),
            Engine::None => ("none", None),
        };
        let process = match &self.child {
            _ if self.stdio_starting => "starting",
            Some(child) if child.terminal_receipt().is_some() => "exited",
            Some(_) => "running",
            // A PTY tab's CLI runs in its pane, not as a child of the tab.
            None if matches!(self.engine, Engine::Cli(_)) => "running",
            None => "none",
        };
        crate::recovery_log::State {
            turn_open: self.turn_open, pending_asks: self.pending.len(), queued: self.queued.len(),
            displayed: match self.status { TabStatus::Idle => "idle", TabStatus::InProgress => "in_progress", TabStatus::Completed => "completed", TabStatus::Waiting => "waiting" },
            recovery: self.recovery, stalled: self.stalled_at.is_some(), engine, process, connection,
        }
    }

    /// The agent the tab's incident lines name, read from its entry.
    fn incident_agent(&mut self) {
        let Some(tab) = index::get(&self.session_id).ok().and_then(|entry| entry.tab(&self.tab_id).cloned()) else { return };
        use crate::store::index::AgentTransport;
        let transport = match tab.transport { AgentTransport::Pty => "pty", AgentTransport::ExperimentalCodexStdio => "codex_stdio" };
        self.incidents.set_agent(crate::recovery_log::Agent::new(&tab.harness, transport, Some(&tab.model), tab.effort.as_deref()));
    }

    /// The tab's private diagnostics, beside its log.
    fn diagnostics_path(&self) -> PathBuf {
        self.log_path.with_extension("diagnostics.jsonl")
    }

    fn key(&self) -> String {
        format!("{}/{}", self.session_id, self.tab_id)
    }

    /// What the agent's launch is recorded under in `cloud_grants` and
    /// `cloud_config`: a CLI's pane, else the tab.
    fn launch_key(&self) -> String {
        match &self.engine {
            Engine::Cli(cli) => cli.pane_id.clone(),
            _ => self.key(),
        }
    }
}

#[cfg(test)]
pub fn idle_orphaned_tabs() {
    idle_orphaned_tabs_except(&std::collections::HashSet::new(), &std::collections::HashSet::new());
}

/// No child survives a restart: a tab persisted mid-turn or waiting is idle
/// now, whatever the index says, and no tab has a pane. What the runtime
/// this one replaced handed over is the exception (#765): `tabs` keep their
/// turns and `panes` their terminals, which go on running.
pub fn idle_orphaned_tabs_except(tabs: &std::collections::HashSet<(String, String)>, panes: &std::collections::HashSet<String>) {
    let _ = index::update(|sessions| {
        for s in sessions.iter_mut() {
            for t in s.tabs.iter_mut() {
                if !tabs.contains(&(s.id.clone(), t.id.clone())) && matches!(t.status, TabStatus::InProgress | TabStatus::Waiting) {
                    t.status = TabStatus::Idle;
                }
                // Nor does any pane.
                if !panes.contains(&t.pane_id()) {
                    t.lose_pane();
                }
            }
        }
        Ok(())
    });
}

#[derive(Clone)]
pub struct SessionManager {
    row_prs: Arc<row_status::PrCache>,
    pub(crate) history_downloads: Arc<crate::local_runtime::history::Downloads>,
    /// Desktop typing waiting for its programs to read it (#661).
    pub(crate) typing: Arc<crate::local_runtime::typing::Typing>,
    pub(crate) mobile: Arc<crate::local_runtime::mobile::Registry>,
    pub(crate) sharing: Arc<Mutex<crate::local_sharing::Sharing>>,
    sink: Arc<dyn EventSink>,
    observer: Arc<dyn SessionObserver>,
    host: Arc<Host>,
    terminals: Arc<pty::Terminals>,
    codex_models: Arc<codex::models::Cache>,
    status: Arc<crate::status::StatusState>,
    control: crate::hooks::ControlEndpoint,
    tabs: Arc<Mutex<HashMap<String, Arc<Mutex<TabRuntime>>>>>,
    provider_states: Arc<Mutex<HashMap<String, ProviderTabState>>>,
    /// Explicit command grants for this tab's conversation. Kept across
    /// turns and CLI restarts; forgotten when the owner runtime exits.
    session_commands: Arc<Mutex<HashMap<String, std::collections::HashSet<String>>>>,
    /// Each tab's agent process, by `key_of`, as `TabRuntime::child_pid` says,
    /// kept apart so placing a process (PRO-468) never waits on a tab's lock.
    children: Arc<Mutex<HashMap<String, u32>>>,
    /// One writer per pane, so two prompts sent in quick succession cannot
    /// interleave their paste and their Enter, nor overtake one another.
    writers: Arc<Mutex<HashMap<String, Arc<PaneWriter>>>>,
    starts: Arc<std::sync::atomic::AtomicU64>,
    shutting_down: Arc<std::sync::atomic::AtomicBool>,
    /// Only callers hold this sender; its last drop wakes and ends the watcher.
    watcher_lifetime: Option<std::sync::mpsc::Sender<()>>,
    stop_pids: Arc<Mutex<Vec<u32>>>,
    session_stop_pids: Arc<Mutex<HashMap<String, Vec<u32>>>>,
    /// Exact detached launches survive a failed Stop; retry never resolves a
    /// pane name again and accidentally targets its replacement.
    stopping_ptys: Arc<Mutex<HashMap<String, Vec<pty::StoppingPane>>>>,
    /// Tabs following their terminal (#437); off until the desktop app asks.
    follow: Arc<follow::Following>,
    /// New tabs whose agent's first start is still told apart (PRO-291).
    first_starts: Arc<FirstStarts>,
    /// What automatic account switching remembers between decisions (#981).
    account_switch: Arc<Mutex<crate::agent_accounts::auto_switch::Memory>>,
    /// Tabs whose log last told of a question in the CLI's own screen
    /// (PRO-460), by `key_of`: kept apart from the CLI, so a stop, an exit or
    /// a restart that drops the CLI still takes the card down.
    screen_prompts: Arc<Mutex<std::collections::HashSet<String>>>,
}

/// Native tab-lifetime sidecar; weak runtime ownership avoids retaining tabs.
/// Accessed only while that runtime is held, never used to acquire runtime.
struct ProviderTabState {
    runtime: std::sync::Weak<Mutex<TabRuntime>>,
    binding: Option<provider_authority::ProviderBinding>,
    queue: provider_authority::QueueCarriers,
    acp_carried: bool,
    opencode: OpenCodeOwner,
    operations: HashMap<String, provider_authority::OperationContext>,
    settings: HashMap<String, provider_authority::OperationContext>,
}

#[cfg(test)]
type OpenCodeBeforeCallback = Box<dyn FnOnce(&opencode::NativeHttpReply) + Send>;

#[derive(Default)]
struct OpenCodeOwner {
    carried: bool,
    preparing: Option<(u64, provider_authority::OperationContext)>,
    requests: HashMap<String, OpenCodeRequest>,
    answers: HashMap<String, String>,
    #[cfg(test)]
    before_writes: std::collections::VecDeque<Box<dyn FnOnce() + Send>>,
    #[cfg(test)]
    before_callbacks: std::collections::VecDeque<OpenCodeBeforeCallback>,
    asks: HashMap<String, (String, String)>,
}

#[derive(Clone)]
struct OpenCodeRequest {
    context: provider_authority::OperationContext,
    generation: u64,
    tag: String,
    prompt_seq: Option<u64>,
    ask_incarnation: Option<String>,
}

impl Drop for ProviderTabState {
    fn drop(&mut self) {
        self.queue.clear();
        for context in self.operations.values().chain(self.settings.values()) { context.withdraw(); }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabPtyEvent {
    pub session_id: String,
    pub tab_id: String,
    pub pane_id: String,
    pub command: String,
    pub harness: String,
    /// The CLI in the pane was started by hand in it (#437).
    #[serde(default)]
    pub by_hand: bool,
    /// The pane holds a shell and no agent: the tab is a terminal (#437).
    #[serde(default)]
    pub terminal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub queued: bool,
    pub events: Vec<AgentEvent>,
    /// A continuation the CLI has not taken, whose text is in its input,
    /// where one Enter sends it (#662). Never set by a plain send.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub in_input: bool,
}

/// A tab as `terminalx wait` judges it (#668), read under the tab's lock so
/// its parts agree with each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WaitView {
    pub status: TabStatus,
    /// Permission requests and questions someone can answer: what
    /// `permissions list` shows of the tab.
    pub asks: bool,
    /// The error the agent stopped on, while the tab waits on someone for it.
    pub recovery: Option<RecoveryKind>,
    /// A prompt the agent has yet to take: queued by the app, or held behind
    /// the turn in the CLI's input.
    pub queued: bool,
    pub running: bool,
}

struct PromptText {
    request_id: Option<uuid::Uuid>,
    collaboration: Option<CollaborationPermit>,
    /// A new desktop follow-up: decide again under the final send lock.
    /// Some(true) requests interrupt-and-send; Some(false) holds it.
    hold_if_busy: Option<bool>,
    mobile: Option<crate::local_runtime::mobile::WritePermit>,
    shared_connection: Option<crate::local_sharing::WritePermit>,
    author: Option<crate::local_sharing::Person>,
    /// What the message is, when TerminalX sends it for a bot or to one (PRO-539): shown as a card, beside `display`.
    bot: Option<Box<crate::events::BotMessage>>,
    agent: String,
    display: String,
    /// Stored attachments (PRO-290), already checked to be the session's.
    /// `agent` gains their paths in `send_admitted`; `display` never does.
    files: Vec<FileRef>,
}

impl PromptText {
    fn append_agent_context(&mut self, context: &str) {
        if !context.is_empty() {
            self.agent.push_str("\n\n");
            self.agent.push_str(context);
        }
    }
}

/// The checkout's tree for a prompt's `baseline`, read before it was admitted.
struct PreparedBaseline {
    cwd: String,
    tree: Option<String>,
    at: Instant,
}

/// How old a prepared tree may be and still stand for the checkout when its
/// prompt is published. Past it the tree is read again.
const PREPARED_BASELINE_FRESH: Duration = Duration::from_secs(10);

/// When a send reached this runtime, and when the window says Send was pressed.
struct Received {
    pressed_at: Option<i64>,
    wall: chrono::DateTime<chrono::Utc>,
    at: Instant,
}

impl Received {
    fn now(pressed_at: Option<i64>) -> Self {
        Self { pressed_at, wall: chrono::Utc::now(), at: Instant::now() }
    }
}

/// A window's timings of a message it sent and then drew, in milliseconds
/// since the epoch by its own clock (`SessionManager::note_shown`).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendShown {
    /// When Send was pressed.
    pub pressed_at: Option<i64>,
    /// When the message was first drawn, as sending, before any answer.
    pub drawn_at: Option<i64>,
    /// When the runtime's answer reached the window.
    pub answered_at: Option<i64>,
    /// When the message was drawn as sent.
    pub shown_at: i64,
}

#[derive(Default)]
struct PromptDelivery {
    collaboration: Option<CollaborationPermit>,
    mobile: Option<(crate::local_runtime::mobile::WritePermit, String, String, u64)>,
    ready: Option<Arc<tui::Ready>>,
    /// The composer's `user_message` this is the typing of. `None` for a
    /// command the app types for itself, which is nobody's message.
    seq: Option<u64>,
    /// Sent behind a running turn, for the CLI to hold.
    queued: bool,
    receipt: Option<(u64, DeliveryReceipt)>,
    shared: Option<(crate::local_sharing::WritePermit, String, String, u64)>,
    /// How many stops the reader had made when this was sent
    /// ([`InputBox::stops`]): taken by the sender, which holds the tab, so a
    /// stop made before the typing starts is never mistaken for an earlier one.
    stops: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub media_type: String,
    pub data: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// Archived image refs for the log, and (media type, base64) pairs for the wire.
type ArchivedImages = (Vec<ImageRef>, Vec<(String, String)>);

/// Who types into a pane: one prompt at a time, and in the order they were
/// sent. Each prompt is typed from a thread of its own, and threads do not
/// get going in the order they were made, so the order is a ticket each one
/// is handed while its sender still has the tab (#663): a continuation sent
/// again at launch reaches the CLI ahead of the prompt that launched it.
#[derive(Default)]
struct PaneWriter {
    typing: Mutex<()>,
    turns: Mutex<Turns>,
    turn: std::sync::Condvar,
}

/// The tickets handed out, the oldest still being typed, and those done out
/// of order (a thread that never started gives its ticket back early).
#[derive(Default)]
struct Turns {
    next: u64,
    serving: u64,
    done: std::collections::BTreeSet<u64>,
}

impl PaneWriter {
    /// The pane to oneself, whichever turn it is: a test standing in for a
    /// prompt still being typed.
    #[cfg(test)]
    fn lock(&self) -> std::sync::LockResult<MutexGuard<'_, ()>> {
        self.typing.lock()
    }

    /// The pane, unless a prompt is being typed into it right now. Never
    /// waits, whatever turn it is: an Enter written again (#662) is held back
    /// for a prompt being typed, whose own Enter is coming, and its caller
    /// has the tab, which whoever is typing takes while holding the pane.
    fn try_lock(&self) -> std::sync::TryLockResult<MutexGuard<'_, ()>> {
        self.typing.try_lock()
    }

    /// A place in the line, behind every prompt sent before it. Never blocks.
    fn ticket(self: &Arc<Self>) -> Ticket {
        let mut turns = self.turns.lock().unwrap_or_else(|e| e.into_inner());
        let number = turns.next;
        turns.next += 1;
        Ticket { writer: self.clone(), number }
    }
}

/// A prompt's place in its pane's line; giving it up (dropping it) lets the
/// next one go, whether it was typed, failed, or never got going.
struct Ticket {
    writer: Arc<PaneWriter>,
    number: u64,
}

impl Ticket {
    /// Wait for every prompt sent before this one, then take the pane.
    fn take(&self) -> MutexGuard<'_, ()> {
        let mut turns = self.writer.turns.lock().unwrap_or_else(|e| e.into_inner());
        while turns.serving < self.number {
            turns = self.writer.turn.wait(turns).unwrap_or_else(|e| e.into_inner());
        }
        drop(turns);
        self.writer.typing.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut guard = self.writer.turns.lock().unwrap_or_else(|e| e.into_inner());
        let turns = &mut *guard;
        turns.done.insert(self.number);
        while turns.done.remove(&turns.serving) {
            turns.serving += 1;
        }
        drop(guard);
        self.writer.turn.notify_all();
    }
}

/// How long a restart waits for the outgoing CLI to let go of its conversation.
const RESTART_WAIT: std::time::Duration = std::time::Duration::from_secs(6);
/// How long a stop waits, from its signal, for the agent's exit to be
/// confirmed: what a tab's close tells the reader it waited (PRO-291).
const STOP_CONFIRM_WAIT: Duration = Duration::from_secs(recovery::CLOSE_WAIT_SECS);
/// Columns and rows every agent CLI starts at. A view that controls the
/// pane's size (the desktop's terminal view, a cloud tab's controller)
/// resizes it from here.
pub const CLI_PANE_SIZE: (u16, u16) = (120, 30);

/// Where a process runs among the runtime's panes (PRO-468): a session and
/// its tab, a session with no tab, or a TerminalX pane of no session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Placed {
    pub session: Option<String>,
    pub tab: Option<String>,
}

/// [`SessionManager::pending_permissions_now`]'s last read of each tab, by its key, with when it was read.
static LAST_PENDING: Mutex<std::collections::BTreeMap<String, (std::time::Instant, Vec<PendingPermission>)>> = Mutex::new(std::collections::BTreeMap::new());
/// How long a tab whose lock stays held (a wedged launch) keeps showing what it was last read to ask.
const PENDING_MEMORY: std::time::Duration = std::time::Duration::from_secs(60);

/// A shorter [`PENDING_MEMORY`] in tests, in milliseconds.
#[cfg(test)]
pub(crate) static PENDING_MEMORY_FOR_TESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);

fn pending_memory() -> std::time::Duration {
    #[cfg(test)]
    {
        let millis = PENDING_MEMORY_FOR_TESTS.load(std::sync::atomic::Ordering::SeqCst);
        if millis != u64::MAX {
            return std::time::Duration::from_millis(millis);
        }
    }
    PENDING_MEMORY
}

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

/// What a permission hook asks to run, for telling a repeat of a call that
/// still waits on a card (PRO-160). It is the tool's input less the agent's
/// own words about it (`description`, `justification`). Codex adds those
/// at `PermissionRequest`, and a model running the call again may reword
/// them. It also leaves out a command's trailing whitespace, since Codex
/// drops a patch's last newline at `PermissionRequest`.
fn asked_to_run(input: &Value) -> Value {
    let mut what = input.clone();
    if let Some(fields) = what.as_object_mut() {
        fields.remove("description");
        fields.remove("justification");
        for key in ["command", "cmd"] {
            if let Some(Value::String(command)) = fields.get_mut(key) {
                command.truncate(command.trim_end().len());
            }
        }
    }
    what
}

/// The hook a command TerminalX runs itself answers ([`SessionManager::run_discovery`]).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Answering {
    /// An Ask-mode permission gate: Codex's `PreToolUse`, Claude's
    /// `PermissionRequest`. Unanswered, a person is asked next.
    Permission,
    /// A run verifier's `PreToolUse`, for either agent. Unanswered, its agent
    /// would run the command itself, so an unfinished run is refused.
    Verifier,
}

/// Whether the provider's own sandbox could have narrowed what a command run
/// in `cwd` reads (PRO-330). TerminalX runs a vetted read-only command itself,
/// outside that sandbox, only when it could not. Not knowing is "it could".
fn provider_may_restrict(kind: CliKind, session_id: &str, tab_id: &str, cwd: &Path, transcript: Option<&str>) -> bool {
    // The command's directory and the tab's launch directories: the CLI
    // loaded project settings from where it started, whatever `cd` the model
    // ran since.
    let Ok(session) = index::get(session_id) else { return true };
    let dirs = [cwd, Path::new(&session.cwd), Path::new(&session.project_path)];
    let dirs: Vec<&Path> = dirs.into_iter().filter(|dir| dir.is_absolute()).collect();
    // The settings of the account the tab runs on (#980), which its CLI
    // loaded instead of This Mac's own.
    let (claude_account, codex_account) = account_dirs(kind, session.tab(tab_id));
    let sources = crate::harness::provider_sandbox::Sources::from_env_on(transcript, claude_account.as_deref(), codex_account);
    match kind {
        CliKind::Claude => crate::harness::provider_sandbox::claude_may_restrict(&dirs, &sources),
        CliKind::Codex => crate::harness::provider_sandbox::codex_may_restrict(&dirs, &sources),
    }
}

/// The added account `tab` runs on (#980): Claude Code's directory, or the
/// Codex account's managed home. Neither on This Mac's login or a key.
fn account_dirs(kind: CliKind, tab: Option<&TabEntry>) -> (Option<PathBuf>, Option<PathBuf>) {
    let Some(id) = tab.and_then(crate::session_ops::tab_running_account) else { return (None, None) };
    let harness = match kind { CliKind::Claude => "claude", CliKind::Codex => "codex" };
    let Some(dir) = crate::agent_accounts::directory(harness, id).ok().flatten() else { return (None, None) };
    match kind {
        CliKind::Claude => (Some(dir), None),
        CliKind::Codex => (None, store::root().ok().map(|root| codex::home::account_paths(&root, id).1)),
    }
}

/// The directory this provider proves the command will execute in. Codex's
/// session cwd is not its exec_command workdir, so it is never a fallback.
fn permission_directory(kind: CliKind, payload: &Value) -> Option<&str> {
    let input = &payload["tool_input"];
    match kind {
        CliKind::Codex => {
            crate::harness::read_only::command(payload["tool_name"].as_str()?, input)?;
            crate::harness::read_only::explicit_cwd(input)
        }
        CliKind::Claude => {
            let cwd = payload["cwd"].as_str().filter(|cwd| Path::new(cwd).is_absolute())?;
            // Claude's Bash uses the hook cwd. Do not treat unsupported or
            // conflicting execution-directory arguments as an override.
            for field in ["workdir", "cwd"] {
                if input.get(field).is_some() && input[field].as_str() != Some(cwd) { return None; }
            }
            Some(cwd)
        }
    }
}

/// Why a permission hook's card is up, in TerminalX's words (#775): the
/// gate that asked, which the agent's own description of the call never
/// says. None when the session's own mode asked, which needs no telling.
///
/// Codex in Ask every time is asked by the app, at `PreToolUse`. Its
/// sandbox asks for itself at `PermissionRequest`, in any mode, when a call
/// is to run outside it, with the agent's justification as the call's
/// description. That is a wider grant than running the command, and the
/// reader is told so (PRO-160). TerminalX's Claude hooks only ever deny, so a Claude
/// `PermissionRequest` in bypass mode comes from a check bypass does not
/// cover: Claude Code's own safety check. The hook's `permission_mode` is
/// the mode Claude is in when it asks, and decides; the tab's is the
/// fallback for a frame without it. The card is still shown: answering it
/// unasked would switch off Claude's last guard against destructive
/// commands.
fn asked_because(kind: CliKind, gate: &str, payload: &Value, tab_mode: &str, tool_name: &str) -> Option<String> {
    match kind {
        CliKind::Codex => match gate {
            "PreToolUse" => codex::asks_every_tool(tab_mode).then(|| "Approval is required because this session is set to Ask every time.".into()),
            "PermissionRequest" => Some(codex::pty::OUTSIDE_SANDBOX.into()),
            _ => None,
        },
        CliKind::Claude => {
            let mode = payload["permission_mode"].as_str().map(str::trim).filter(|m| !m.is_empty()).unwrap_or(tab_mode);
            (gate == "PermissionRequest" && mode == "bypassPermissions").then(|| claude::mapper::safety_check_reason(tool_name).into())
        }
    }
}

/// The reader's decision as the hook that asked has to print it.
fn reply_for(kind: CliKind, event: &str, decision: Decision) -> HookReply {
    if let Decision::Execute(input) = decision {
        let output = match (kind, event) {
            (CliKind::Codex, "PreToolUse") => codex::pty::pre_tool_rewrite(input),
            (CliKind::Claude, _) => claude::pty::permission_decision(true, Some(input), vec![]),
            // Codex PermissionRequest cannot rewrite input. Never drop a
            // directory guard and accidentally allow the unchanged command.
            (CliKind::Codex, _) => codex::pty::permission_decision(false),
        };
        return HookReply { output: Some(output), refused: None };
    }
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
        let (watcher_lifetime, stop_watching) = std::sync::mpsc::channel();
        let manager = Self {
            row_prs: Arc::default(),
            mobile: Arc::new(crate::local_runtime::mobile::Registry::default()),
            sharing: Arc::new(Mutex::new(crate::local_sharing::Sharing::default())),
            sink,
            observer,
            host,
            terminals,
            codex_models,
            status,
            control,
            tabs: Arc::new(Mutex::new(HashMap::new())),
            provider_states: Arc::default(),
            session_commands: Arc::default(),
            children: Arc::default(),
            writers: Arc::new(Mutex::new(HashMap::new())),
            starts: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            watcher_lifetime: Some(watcher_lifetime),
            history_downloads: Arc::default(),
            typing: Arc::default(),
            stop_pids: Arc::new(Mutex::new(Vec::new())),
            session_stop_pids: Arc::default(),
            stopping_ptys: Arc::default(),
            follow: Arc::default(),
            first_starts: Arc::default(),
            screen_prompts: Arc::default(),
            account_switch: Arc::default(),
        };
        let mut watcher = manager.clone();
        // The polling copy must not keep its own lifetime alive. In particular,
        // dropping a test fixture must release its thread and retained state.
        drop(watcher.watcher_lifetime.take());
        std::thread::spawn(move || {
            // Preserve the five-second polling interval, but wake immediately
            // when every caller has dropped its manager.
            while matches!(stop_watching.recv_timeout(std::time::Duration::from_secs(5)), Err(std::sync::mpsc::RecvTimeoutError::Timeout)) {
                watcher.watch_tabs(recovery::Patience::DEFAULT, Instant::now(), |pane| watcher.terminals.last_output(pane));
            }
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
        self.provider_states.lock().unwrap().retain(|_, state| state.runtime.strong_count() != 0);
        let tabs: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        for rt_arc in tabs {
            let mut rt = rt_arc.lock().unwrap();
            let (pane, ended) = match &rt.engine {
                Engine::Cli(p) => (Some(p.pane_id.clone()), p.transcript_turn.is_some_and(tui::TurnMark::ends)),
                _ => (None, false),
            };
            self.give_up_on_unanswered_settings(&mut rt, now);
            let silent = now.saturating_duration_since(rt.last_activity);
            // /compact has no model turn or Stop hook. Its compact boundary
            // confirms completion; Claude may repeat the command after the summary.
            let compact_done = rt.turn_by_command && rt.compact_completed
                && rt.turn_opener.is_some_and(|(_, kind)| kind == "compact_command");
            if rt.turn_open && (ended || compact_done) && silent >= patience.settle {
                if compact_done {
                    if let Engine::Cli(p) = &mut rt.engine {
                        // The boundary is the command's completion. No later
                        // turn_duration is owed for it; that belongs to the next turn.
                        p.transcript_turn = Some(tui::TurnMark::Ended);
                    }
                }
                let final_message = match &rt.engine {
                    Engine::Cli(p) => p.turn_tail.last_assistant_message().map(str::to_owned),
                    _ => None,
                };
                // Not `close_open_turn`: that one defers to the latch that
                // keeps two closers from racing, and a turn a hook opened
                // never reset it. Left to the latch, such a turn would not
                // close here, and skipping the rest of the pass for it would
                // leave the tab "Working" for good with no warning either.
                let completed = (rt.turn_generation, rt.turn_started_at, chrono::Utc::now());
                self.end_open_turn(&mut rt, TurnStatus::Ok, None);
                self.after_turn_completed(&rt_arc, rt, final_message, completed);
                continue;
            }
            self.nudge_if_due(&mut rt, now);
            // A prompt whose Enter was written to an idle CLI is acknowledged
            // at once or not at all. The pane drawing is no acknowledgement —
            // a paste landing in the composer draws too — so this does not
            // wait out the stall limit, and only the CLI's word takes it back.
            let overdue = match &mut rt.engine {
                Engine::Cli(p) if p.awaiting_delivery.is_some() && p.accept_by.is_some_and(|by| now >= by) => {
                    p.accept_by = None;
                    p.awaiting_delivery.zip(p.delivery_sent_at)
                }
                _ => None,
            };
            if let Some((seq, sent_at)) = overdue {
                if rt.recovery.is_none() && rt.pending.is_empty() {
                    recovery::diagnose_delivery(&rt.diagnostics_path(), seq, "unconfirmed", now.saturating_duration_since(sent_at), serde_json::json!({ "queued": false }));
                    self.needs_recovery(&mut rt, RecoveryKind::DeliveryUnconfirmed, crate::recovery_log::Source::Delivery);
                    continue;
                }
            }
            // A prompt queued behind a turn that is over, and still not taken.
            if !rt.turn_open {
                let unsent = match &mut rt.engine {
                    Engine::Cli(p) => p.expire_echoes(false, now),
                    _ => Vec::new(),
                };
                if self.queued_prompts_unsent(&mut rt, &unsent) {
                    continue;
                }
            }
            // Only a PTY-first tab has a pane; the other engines are judged
            // on their events alone, as before.
            let drawn = pane.and_then(|pane| drawn_at(&pane));
            // A question the CLI drew in its own screen has the tab waiting
            // on the reader, not stalled (PRO-460).
            self.watch_screen_prompt(&mut rt, drawn.map(|drawn| now.saturating_duration_since(drawn)));
            if let Some(at) = rt.stalled_at {
                if drawn.is_some_and(|drawn| drawn > at) {
                    rt.incidents.progress("terminal_output");
                    self.stall_disproved(&mut rt);
                }
                continue;
            }
            let quiet = drawn.map_or(silent, |drawn| now.saturating_duration_since(drawn).min(silent));
            // A CLI the reader started by hand answers its own questions in
            // its own screen, and nothing says when it is doing so: silence
            // there is not a stall the app can call.
            let by_hand = matches!(&rt.engine, Engine::Cli(p) if p.by_hand.is_some());
            if !by_hand && recovery::is_stale(rt.turn_open && rt.status == TabStatus::InProgress, quiet, patience) {
                let kind = if matches!(&rt.engine, Engine::Cli(p) if p.awaiting_delivery.is_some()) {
                    RecoveryKind::DeliveryUnconfirmed
                } else {
                    RecoveryKind::Timeout
                };
                recovery::diagnose_stall(&rt.diagnostics_path(), rt.turn_opener, quiet);
                let source = if kind == RecoveryKind::Timeout { crate::recovery_log::Source::Watcher } else { crate::recovery_log::Source::Delivery };
                self.needs_recovery(&mut rt, kind, source);
                rt.stalled_at = Some(now);
            }
        }
    }

    /// Look at what the tab's CLI has drawn for a question it is stopped on
    /// that no hook reported (PRO-460), and tell the chat when one comes or
    /// goes. `quiet`: how long the pane has gone without drawing.
    ///
    /// One it can read is shown with its choices once it has stood still:
    /// the pane quiet for a moment, or the same question read on two passes
    /// in a row (a CLI that keeps redrawing a timer around it). Its input box
    /// gone for two looks in a row, with nothing readable in its place, is a
    /// question too, one the chat can only send the reader to the terminal
    /// for. Either has the tab waiting on the reader, and its going puts the
    /// tab back. A question a hook asked has its own card, and is left to it.
    /// A CLI that is no longer there to ask (stopped, exited, left the
    /// terminal, starting again) asks nothing: a question shown is taken down.
    fn watch_screen_prompt(&self, rt: &mut TabRuntime, quiet: Option<Duration>) {
        let pane = match &rt.engine {
            Engine::Cli(p) if p.harness == CliKind::Claude && p.by_hand.is_none() => Some(p.pane_id.clone()),
            _ => None,
        };
        let live = pane.as_ref().is_some_and(|pane| self.terminals.is_running(pane))
            && self.left_the_terminal(rt).is_none()
            && matches!(&rt.engine, Engine::Cli(p) if p.ready.marked());
        let (Some(pane), true) = (pane, live) else {
            self.screen_prompt_is(rt, None);
            return;
        };
        if !rt.pending.is_empty() {
            return;
        }
        // A prompt being typed in is not something the CLI is asking.
        let writer = self.writers.lock().unwrap().get(&pane).cloned();
        let Ok(_typing) = writer.as_ref().map_or(Ok(None), |writer| writer.try_lock().map(Some)) else { return };
        let Some((read, composer)) = self.terminals.screen(&pane, |screen| (claude::pty::terminal_prompt(screen), claude::pty::composer(screen))) else { return };
        let quiet = quiet.unwrap_or_default();
        let Engine::Cli(p) = &mut rt.engine else { return };
        let state = &mut p.input.prompt;
        if composer != tui::Composer::Unseen {
            state.box_seen = true;
        }
        let found = match read {
            Some(prompt) => {
                state.unread_passes = 0;
                let steady = quiet >= SCREEN_PROMPT_QUIET || state.candidate.as_ref() == Some(&prompt) || state.shown.as_ref() == Some(&prompt);
                if !steady {
                    // Still being drawn, or drawn around: looked at again on the next pass.
                    state.candidate = Some(prompt);
                    return;
                }
                Some(prompt)
            }
            None if composer == tui::Composer::Unseen && state.box_seen && quiet >= SCREEN_PROMPT_UNREAD_QUIET => {
                state.unread_passes = state.unread_passes.saturating_add(1);
                if state.unread_passes < 2 && state.shown.is_none() {
                    return;
                }
                Some(tui::ScreenPrompt::unread())
            }
            None => {
                state.unread_passes = 0;
                None
            }
        };
        if let Engine::Cli(p) = &mut rt.engine {
            p.input.prompt.candidate = None;
        }
        self.screen_prompt_is(rt, found);
    }

    /// The question the CLI's screen shows now, if any: told to the chat when
    /// it changed, and the tab's status kept in step with it. A tab whose CLI
    /// has gone keeps nothing of it but the record here of what its log said.
    fn screen_prompt_is(&self, rt: &mut TabRuntime, found: Option<tui::ScreenPrompt>) {
        let key = rt.key();
        let logged = self.screen_prompts.lock().unwrap().contains(&key);
        let (shown, was, made_waiting) = match &mut rt.engine {
            Engine::Cli(p) => {
                let state = &mut p.input.prompt;
                let shown = std::mem::replace(&mut state.shown, found.clone());
                if found.is_none() {
                    state.candidate = None;
                    state.unread_passes = 0;
                }
                (shown, state.was, p.input.made_waiting)
            }
            _ => (None, None, false),
        };
        let gone = found.is_none() && (shown.is_some() || logged);
        if shown != found || gone {
            self.publish(rt, Payload::TerminalPrompt { prompt: found.clone() }, None);
        }
        {
            let mut prompts = self.screen_prompts.lock().unwrap();
            if found.is_some() { prompts.insert(key); } else { prompts.remove(&key); }
        }
        if found.is_some() {
            // Again if something since (a Stop hook) said otherwise while it stayed up.
            if rt.status != TabStatus::Waiting && rt.pending.is_empty() {
                if let Engine::Cli(p) = &mut rt.engine {
                    p.input.prompt.was = Some(rt.status);
                }
                self.set_status(rt, TabStatus::Waiting);
            }
        } else if gone {
            if let Engine::Cli(p) = &mut rt.engine {
                p.input.prompt.was = None;
            }
            // Back to what it was, unless something else has it waiting now.
            if rt.status == TabStatus::Waiting && rt.pending.is_empty() && rt.recovery.is_none() && !made_waiting {
                let back = if rt.turn_open {
                    TabStatus::InProgress
                } else {
                    match was {
                        Some(TabStatus::Completed) => TabStatus::Completed,
                        _ => TabStatus::Idle,
                    }
                };
                self.set_status(rt, back);
            }
        }
    }

    /// Answer the question the tab's CLI drew in its own screen (PRO-460):
    /// `choice`, by moving its pointer there with the arrow keys and pressing
    /// Enter, or with no choice, Escape, where its hint offers that. Only
    /// the question the chat showed (`prompt_id`), and only while the screen
    /// still shows it: keys meant for it would answer anything else.
    pub fn answer_terminal_prompt(&self, session_id: &str, tab_id: &str, prompt_id: &str, choice: Option<usize>) -> Result<()> {
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_approval()?; }
        let rt_arc = self.runtime(session_id, tab_id)?;
        let (pane, writer) = {
            let rt = rt_arc.lock().unwrap();
            let Engine::Cli(p) = &rt.engine else { bail!("This agent does not ask questions in its terminal.") };
            if p.harness != CliKind::Claude {
                bail!("This agent does not ask questions in its terminal.");
            }
            if self.left_the_terminal(&rt).is_some() || !self.terminals.is_running(&p.pane_id) {
                bail!("The agent is no longer running.");
            }
            // A dialog a hook is waiting on is answered on its own card, so the
            // hook's request and the terminal stay in step.
            if !rt.pending.is_empty() {
                bail!("The agent is asking something else first. Answer that request, then this question.");
            }
            (p.pane_id.clone(), self.writers.lock().unwrap().get(&p.pane_id).cloned())
        };
        let still_up = |what: &str| -> Result<(tui::ScreenPrompt, bool)> {
            let read = self.terminals.screen(&pane, |screen| (claude::pty::terminal_prompt(screen), screen.application_cursor()));
            match read {
                Some((Some(prompt), application)) if prompt.id == prompt_id => Ok((prompt, application)),
                Some((Some(_), _)) => bail!("The question in the agent's terminal has changed. Look at it again before {what}."),
                _ => bail!("That question is no longer showing in the agent's terminal."),
            }
        };
        {
            // Nothing else types into the pane meanwhile.
            let _typing = match writer.as_ref().map(|writer| writer.try_lock()) {
                Some(Err(std::sync::TryLockError::WouldBlock)) => bail!("A message is being typed into the agent right now. Try again in a moment."),
                Some(Err(std::sync::TryLockError::Poisoned(poisoned))) => Some(poisoned.into_inner()),
                Some(Ok(held)) => Some(held),
                None => None,
            };
            let (prompt, application) = still_up("answering")?;
            match choice {
                None => {
                    if prompt.dismiss.is_none() {
                        bail!("This question cannot be dismissed. Choose one of its options.");
                    }
                    // Looked at once more right before the key: an Escape that
                    // lands after the dialog has gone stops a turn instead.
                    still_up("answering")?;
                    self.terminals.write(&pane, tui::ESCAPE).context("Could not reach the agent's terminal")?;
                }
                Some(choice) => {
                    if choice >= prompt.options.len() {
                        bail!("That option is not one of this question's.");
                    }
                    let from = prompt.selected.ok_or_else(|| anyhow!("The agent's terminal shows no option chosen. Open the terminal to answer there."))?;
                    let key = tui::arrow(choice < from, application);
                    let moves = choice.abs_diff(from);
                    for _ in 0..moves {
                        self.terminals.write(&pane, key).context("Could not reach the agent's terminal")?;
                        std::thread::sleep(SCREEN_PROMPT_KEY_GAP);
                    }
                    if moves > 0 {
                        // Claude Code refuses an Enter right after an arrow as a stray key.
                        std::thread::sleep(SCREEN_PROMPT_CONFIRM_GAP);
                    }
                    // Looked at once more right before the Enter, which would
                    // send the input box if the dialog had gone.
                    let (moved, _) = still_up("answering")?;
                    if moved.selected != Some(choice) {
                        bail!("The agent's terminal did not move to that option. Open the terminal to answer there.");
                    }
                    self.terminals.write(&pane, tui::SUBMIT).context("Could not reach the agent's terminal")?;
                }
            }
        }
        self.observer.answered(session_id, tab_id);
        // Take the card down as soon as the CLI has, not at the watcher's next pass.
        std::thread::sleep(SCREEN_PROMPT_SETTLE);
        let mut rt = rt_arc.lock().unwrap();
        let quiet = self.terminals.quiet_for(&pane);
        self.watch_screen_prompt(&mut rt, quiet);
        Ok(())
    }

    /// Write the awaited prompt's Enter once more, if that is due.
    ///
    /// A prompt still unacknowledged a few seconds after its Enter has most
    /// likely kept its text in the input, the Enter having gone by: a CLI
    /// still settling after a resume does that, and so does one that started
    /// a moment ago and was still taking in a long paste (#662). Enter sends
    /// what is there, and does nothing on an input the CLI has emptied.
    ///
    /// The session watcher runs this, and so does a continuation's waiter,
    /// so a handoff is not left waiting a watcher pass for its Enter. One
    /// held back for a prompt being typed is tried again at the next look.
    fn nudge_if_due(&self, rt: &mut TabRuntime, now: Instant) {
        let Engine::Cli(p) = &rt.engine else { return };
        let Some(seq) = p.awaiting_delivery.filter(|_| p.nudge_by.is_some_and(|by| now >= by)) else { return };
        let pane = p.pane_id.clone();
        if self.enter_again(rt, &pane, seq, now, "app") == Nudged::Typing {
            return;
        }
        if let Engine::Cli(p) = &mut rt.engine {
            p.nudges_left = p.nudges_left.saturating_sub(1);
            p.nudge_by = (p.nudges_left > 0).then(|| now + tui::NUDGE_AFTER);
        }
    }

    /// Write the Enter again for `seq`, the prompt the CLI has not
    /// acknowledged, wherever an Enter can only send what is in its input.
    /// `by` says for the diagnostics whose Enter it is: the app's nudge, or
    /// the reader's from the handoff dialog.
    ///
    /// Not while another prompt is being typed into the pane, whose own Enter
    /// is coming; not while the CLI is asking something, where an Enter would
    /// answer it; and not into a CLI that has yet to read what it was given
    /// already. That one is not taking input at all: an Enter queued behind
    /// it says nothing new, and on a full input queue it would never finish
    /// being written, with this tab's lock held (#661).
    fn enter_again(&self, rt: &mut TabRuntime, pane: &str, seq: u64, now: Instant, by: &str) -> Nudged {
        // Held across the write, so no prompt starts typing under it. Only
        // tried: whoever is typing takes this tab's lock while holding it.
        let writer = self.writers.lock().unwrap().get(pane).cloned();
        let _writer = match writer.as_ref().map(|writer| writer.try_lock()) {
            Some(Err(std::sync::TryLockError::WouldBlock)) => return Nudged::Typing,
            Some(Err(std::sync::TryLockError::Poisoned(poisoned))) => Some(poisoned.into_inner()),
            Some(Ok(held)) => Some(held),
            None => None,
        };
        // Nor into a question the CLI drew itself (PRO-460), which it would answer.
        if !rt.pending.is_empty() || matches!(&rt.engine, Engine::Cli(p) if p.input.prompt.shown.is_some()) {
            return Nudged::Asking;
        }
        let (elapsed, continuation) = match &rt.engine {
            Engine::Cli(p) => (
                p.delivery_sent_at.map_or(std::time::Duration::ZERO, |at| now.saturating_duration_since(at)),
                p.echoed.iter().any(|echo| echo.seq == seq && echo.continuation),
            ),
            _ => (std::time::Duration::ZERO, false),
        };
        if let Some(unread) = self.terminals.unread_input(pane).filter(|unread| *unread > 0) {
            log::warn!("[{pane}] {unread} byte(s) of input still unread; not writing the Enter again");
            recovery::diagnose_delivery(&rt.diagnostics_path(), seq, "stalled", elapsed, serde_json::json!({ "queued": false, "unread": unread, "by": by }));
            if continuation {
                self.tell_delivery(&rt.session_id, &rt.tab_id, seq, "stalled");
            }
            return Nudged::Unread(unread);
        }
        let permit = rt.collaboration_prompts.get(&seq).cloned();
        if permit.is_none() && matches!(&rt.engine, Engine::Cli(cli) if cli.echoed.iter().any(|echo| echo.seq == seq && echo.collaboration_required)) {
            return Nudged::Written(false);
        }
        let _policy = match permit.as_ref() {
            Some(permit) => match permit.collaboration.try_enter_admission() {
                Some(guard) => Some(guard),
                None => return Nudged::Typing,
            },
            None => None,
        };
        if permit.as_ref().is_some_and(|permit| Self::check_collaboration_permit(permit, rt).is_err()) {
            return Nudged::Written(false);
        }
        let written = if permit.as_ref().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2()) {
            self.terminals.pid(pane).context("terminal process missing")
                .and_then(|pid| self.terminals.try_write_for_process(pane, pid, tui::SUBMIT))
                .and_then(|written| { anyhow::ensure!(written == tui::SUBMIT.len(), "terminal submit incomplete"); Ok(()) })
        } else {
            self.terminals.write(pane, tui::SUBMIT)
        }.map_err(|e| log::warn!("[{pane}] write the Enter again: {e:#}")).is_ok();
        if let (true, Engine::Cli(p)) = (written, &mut rt.engine) {
            p.entered_at = Some(now);
        }
        recovery::diagnose_delivery(&rt.diagnostics_path(), seq, "nudged", elapsed, serde_json::json!({ "queued": false, "written": written, "by": by }));
        if continuation {
            self.tell_delivery(&rt.session_id, &rt.tab_id, seq, "nudged");
        }
        Nudged::Written(written)
    }

    /// Where a continuation's delivery has got to, for the dialog that sent
    /// it (#662). Which prompt and which stage only, never its text.
    fn tell_delivery(&self, session_id: &str, tab_id: &str, seq: u64, stage: &str) {
        self.sink.emit("prompt_delivery", &serde_json::json!({ "sessionId": session_id, "tabId": tab_id, "seq": seq, "stage": stage }));
    }

    /// A model or effort change typed into a CLI that has not answered it.
    /// A CLI mid-turn may be holding the command until the turn is over, so
    /// the wait is counted from when the turn was last seen running; after
    /// that, a change still shown as on its way would be a promise nobody is
    /// keeping, and it is taken back with a reason.
    fn give_up_on_unanswered_settings(&self, rt: &mut TabRuntime, now: Instant) {
        let turn_open = rt.turn_open;
        let Engine::Cli(p) = &mut rt.engine else { return };
        let Some(asked) = p.settings_asked_at else { return };
        if turn_open {
            p.settings_asked_at = Some(now);
            return;
        }
        if now.saturating_duration_since(asked) < SETTINGS_ANSWER_WAIT {
            return;
        }
        p.settings_asked_at = None;
        for setting in [Setting::Model, Setting::Effort] {
            if let Err(error) = self.refuse_setting(rt, setting, None, "it did not confirm the change") {
                log::warn!("drop an unanswered {} change: {error:#}", setting.noun());
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
        crate::workspace_setup::follow_creations(self);
    }

    pub(crate) fn pipeline(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        use crate::issue_pipeline::{engine,host::LocalHost};
        self.accepting_work()?;
        let host = LocalHost::new(self.sink.clone(),self.clone());
        let string = |key: &str| params[key].as_str().with_context(|| format!("{key} is required"));
        let started = |pipeline| serde_json::json!({"pipeline":pipeline,"authorBrief":crate::issue_pipeline::prompts::author_brief()});
        Ok(match method {
            "attach" => started(engine::start_existing(&host, string("sessionId")?, string("tabId")?, params["autoMerge"].as_bool(), params["resolveConflicts"].as_bool(), true, crate::issue_pipeline::SwitchActor::Person)?),
            "startAgent" => started(engine::start_existing(&host, string("sessionId")?, string("tabId")?, params["autoMerge"].as_bool(), params["resolveConflicts"].as_bool(), params["adoptPr"].as_bool().unwrap_or(false), crate::issue_pipeline::SwitchActor::SelfUi { session_id: params["caller"]["session"].as_str().map(str::to_owned), tab_id: params["caller"]["tab"].as_str().map(str::to_owned) })?),
            "start" => started(engine::start(&host,string("sessionId")?,string("tabId")?,params["autoMerge"].as_bool(),None)?),
            "continue" => engine::continue_launch(&host,string("sessionId")?,string("tabId")?,&serde_json::from_value(params["options"].clone())?)?.map(started).unwrap_or(serde_json::Value::Null),
            "autoMerge" => serde_json::to_value(engine::set_auto_merge(&host,string("id")?,params["value"].as_bool().context("value is required")?)?)?,
            "resolveConflicts" => serde_json::to_value(engine::set_resolve_conflicts_by(&host,string("id")?,params["value"].as_bool().context("value is required")?,crate::issue_pipeline::SwitchActor::Person)?)?,
            "act" => serde_json::to_value(engine::act(&host,string("id")?,serde_json::from_value(params["action"].clone())?)?)?,
            _ => anyhow::bail!("unsupported desktop pipeline operation"),
        })
    }

    /// A person approved or started a run from its Run view: a bot's item that asked them about it is settled
    /// (PRO-501). Not when the start is an item's own answer, which records itself.
    fn started_by_person(&self, params: &serde_json::Value) {
        if params[crate::bots::runs::ANSWERING_ITEM].as_bool() != Some(true) {
            if let Some(id) = params["id"].as_str() {
                crate::bots::runs::started_from_run_view(self.sink.as_ref(), id);
            }
        }
    }

    /// What the window asks of orchestration runs (`orchestration`). Approve
    /// and Edit are here and nowhere in the `terminalx` CLI: the lead runs
    /// the CLI, and a lead does not approve its own plan.
    pub(crate) fn orchestration(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        use crate::orchestration::{engine, host::ManagerHost, store};
        let host = ManagerHost::new(self.sink.clone(), self.clone());
        let string = |key: &str| params[key].as_str().with_context(|| format!("{key} is required"));
        // A refusal keeps its code and its particulars: the window shows a refused edit by the piece it names.
        let refused = |error: engine::EngineError| anyhow!("{}", serde_json::to_string(&error).unwrap_or_else(|_| error.message.clone()));
        Ok(match method {
            "forSession" => match store::for_lead(string("sessionId")?)? {
                Some(run) => engine::shown(&engine::refreshed(&host, &run.id).map_err(refused)?),
                None => serde_json::Value::Null,
            },
            "list" => serde_json::Value::Array(store::list()?.iter().map(engine::shown).collect()),
            // A plan file a person chose in the session's Run view: checked and stored as the CLI's would be.
            "create" => engine::shown(&engine::create(&host, &crate::orchestration::plan::parse(&params["plan"]).map_err(|error| refused(error.into()))?, string("sessionId")?, None).map_err(refused)?),
            "approve" => {
                self.accepting_work()?;
                let approved = serde_json::to_value(engine::approve(&host, string("id")?).map_err(refused)?)?;
                self.started_by_person(&params);
                approved
            }
            "start" => {
                self.accepting_work()?;
                serde_json::to_value(engine::start(&host, string("id")?).map_err(refused)?)?
            }
            // A person's Start run on a `planned` run (PRO-365): recorded as theirs, and the lead is told.
            "startPlanned" => {
                self.accepting_work()?;
                let started = serde_json::to_value(engine::start_planned(&host, string("id")?).map_err(refused)?)?;
                self.started_by_person(&params);
                started
            }
            "stop" => serde_json::to_value(engine::stop(&host, string("id")?, engine::By::Person).map_err(refused)?)?,
            // A person's Merge, Continue merge and Skip: the same pass the lead's `runs merge` makes.
            "merge" => {
                self.accepting_work()?;
                let mut options = crate::orchestration::merge::Options::new(engine::By::Person);
                options.skip = params["skip"].as_array().into_iter().flatten().filter_map(|piece| piece.as_str().map(str::to_owned)).collect();
                options.recheck = params["recheck"].as_bool().unwrap_or(false);
                // The checks may run for a long time: the window is answered once the pass holds the
                // checkout, or with why it could not begin, and follows the run's events from there.
                let (told, begun) = std::sync::mpsc::channel();
                options.begun = Some(told.clone());
                let id = string("id")?.to_string();
                let run = id.clone();
                std::thread::Builder::new().name("run-merge".into()).spawn(move || {
                    let ended = crate::orchestration::merge::merge(&host, &run, &options).map(|_| ());
                    if let Err(error) = &ended {
                        log::warn!("merge the pieces of run {run}: {error}");
                    }
                    let _ = told.send(ended);
                })?;
                begun.recv().context("the merge ended without saying how")?.map_err(refused)?;
                engine::shown(&store::get(&id)?)
            }
            "sendBack" => {
                self.accepting_work()?;
                engine::shown(&engine::send_back(&host, string("id")?, string("piece")?).map_err(refused)?.run)
            }
            "resolveInLead" => {
                self.accepting_work()?;
                engine::shown(&engine::resolve_in_lead(&host, string("id")?, string("piece")?).map_err(refused)?)
            }
            // A blocked piece (PRO-361, 18.03): the person's four actions, and checking what the lead did with one it took over.
            "takeOver" => {
                self.accepting_work()?;
                engine::shown(&engine::take_over(&host, string("id")?, string("piece")?, engine::By::Person, false).map_err(refused)?)
            }
            "finish" => {
                self.accepting_work()?;
                let accept: Vec<String> = params["accept"].as_array().into_iter().flatten().filter_map(|path| path.as_str().map(str::to_owned)).collect();
                engine::shown(&engine::finish_accepting(&host, string("id")?, string("piece")?, engine::By::Person, false, &accept).map_err(refused)?.run)
            }
            // What Check and finish would add to a held piece's files, shown before it is pressed.
            "finishWidens" => serde_json::to_value(engine::finish_widens(&host, string("id")?, string("piece")?).map_err(refused)?)?,
            "widen" => {
                self.accepting_work()?;
                let own: Vec<String> = params["own"].as_array().into_iter().flatten().filter_map(|path| path.as_str().map(str::to_owned)).collect();
                engine::shown(&engine::widen(&host, string("id")?, string("piece")?, &own, engine::By::Person).map_err(refused)?.run)
            }
            "note" => {
                self.accepting_work()?;
                engine::shown(&engine::note(&host, string("id")?, string("piece")?, string("text")?, engine::By::Person).map_err(refused)?)
            }
            "skip" => engine::shown(&engine::skip(&host, string("id")?, string("piece")?, engine::By::Person).map_err(refused)?.run),
            "updatePlan" => engine::shown(&engine::update_plan(&host, string("id")?, &crate::orchestration::plan::parse(&params["plan"]).map_err(|error| refused(error.into()))?).map_err(refused)?),
            // A person's own limits for one run (PRO-280): from the approval view, or a paused run's.
            "setLimits" => engine::shown(&engine::set_limits(&host, string("id")?, serde_json::from_value(params["limits"].clone()).context("limits are not a run's limits")?).map_err(refused)?),
            "resume" => {
                self.accepting_work()?;
                let how = if params["afterReset"] == true { engine::Resume::AfterReset } else { engine::Resume::Now };
                serde_json::to_value(engine::resume(&host, string("id")?, how).map_err(refused)?)?
            }
            _ => anyhow::bail!("unsupported orchestration operation"),
        })
    }

    pub(crate) fn workspace(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        crate::local_runtime::workspaces::execute(self, self.sink.as_ref(), method, params)
    }

    pub(crate) fn automation_host(&self) -> crate::automations::RuntimeHost {
        crate::automations::RuntimeHost { sink: self.sink.clone(), sessions: self.clone() }
    }

    pub fn environment_changed(&self, id: &str) -> Result<crate::store::environment::Status> {
        if let Some(status) = self.terminals.environment_changed(id)? { return Ok(status); }
        let Some(tab_id) = id.strip_prefix("tab:") else { return Ok(Default::default()); };
        let tab = self.tabs.lock().unwrap().iter()
            .find(|(key, _)| key.rsplit_once('/').is_some_and(|(_, id)| id == tab_id))
            .map(|(_, tab)| tab.clone());
        if let Some(tab) = tab {
            let stamp = {
                let rt = tab.lock().unwrap();
                rt.child.as_ref().filter(|child| child.terminal_receipt().is_none()).map(|_| rt.environment.clone())
            };
            if let Some(stamp) = stamp { return stamp.status(); }
        }
        Ok(Default::default())
    }

    pub fn terminals(&self) -> &Arc<pty::Terminals> {
        &self.terminals
    }

    /// Where this manager tells the windows what changed.
    pub fn sink(&self) -> &Arc<dyn EventSink> {
        &self.sink
    }

    /// Bind an agent control call to the same launch credential as its hooks.
    /// Session/tab ids alone are selectors, never proof of the caller's identity.
    pub(crate) fn authenticates_cli(&self, session_id: &str, tab_id: &str, token: &str) -> bool {
        let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned();
        runtime.is_some_and(|runtime| {
            let rt = runtime.lock().unwrap();
            match &rt.engine {
                Engine::Cli(cli) => crate::hooks::token_matches(&cli.origin.token, token),
                Engine::CodexStdio(engine) => crate::hooks::token_matches(&engine.hook_token, token),
                _ => false,
            }
        })
    }

    fn runtime(&self, session_id: &str, tab_id: &str) -> Result<Arc<Mutex<TabRuntime>>> {
        let key = key_of(session_id, tab_id);
        one_per_key(&self.tabs, &key, || {
            let entry = index::get(session_id)?;
            let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab {tab_id} not found"))?;
            let log_path = store::log_path(session_id, tab_id)?;
            let seq = store::last_seq(&log_path)?.max(tab.unknown.get("resetSeq").and_then(Value::as_u64).unwrap_or(0));
            let rt = Arc::new(Mutex::new(TabRuntime {
                session_id: session_id.into(),
                tab_id: tab_id.into(),
                acting_bot: crate::bots::chat::acting_bot(&entry),
                bot_builtin: crate::bots::builtins::of_session(&entry),
                harness: tab.harness.clone(),
                seq,
                status: TabStatus::Idle,
                child: None,
                child_pid: None,
                environment: Default::default(),
                engine: Engine::None,
                pending: HashMap::new(),
                queued: Vec::new(),
                held_queue: held::Queue::restore(&log_path)?,
                turn_open: false,
                turn_generation: 0,
                automation_completions_in_flight: 0,
                turn_opener: None,
                compact_completed: false,
                compact_boundary_at: None,
                source_timestamp: None,
                message_times: HashMap::new(),
                compaction: compaction::Admission::default(), stdio_compaction: None, stdio_starting: false, setup_failed: false, stdio_writer: None, stdio_authority: None, stdio_launch_permit: None, stdio_receipt: None, stdio_followups: Default::default(),
                stdio_retiring: None,
                turn_started_at: None,
                turn_usage: Default::default(),
                turn_by_command: false,
                signed_out_in_turn: false,
                last_activity: Instant::now(),
                recovery: None,
                incidents: Default::default(),
                stalled_at: None,
                last_settings_report: None,
                collaboration_stance: None, collaboration_raw: None,
                collaboration_prompts: HashMap::new(), collaboration_settings: HashMap::new(),
                reported_mode_to_judge: None,
                restart_claim: None,
                stopping: false,
                stop_in_flight: false,
                stopping_pid: None,
                background: None,
                left_at: None,
                prepared_baseline: None,
                log_path,
                me: std::sync::Weak::new(),
            }));
            rt.lock().unwrap().me = Arc::downgrade(&rt);
            if codex_stdio::selected(tab) {
                self.reconcile_codex_followups(&mut rt.lock().unwrap())?;
            }
            Ok(rt)
        })
    }

    /// Stamp, persist, emit. The one path every event takes.
    fn publish(&self, rt: &mut TabRuntime, payload: Payload, subagent: Option<SubagentRef>) -> AgentEvent {
        self.publish_event(rt, payload, subagent, None)
    }

    fn publish_prompt(&self, rt: &mut TabRuntime, payload: Payload, request_id: Option<uuid::Uuid>) -> AgentEvent {
        self.publish_event(rt, payload, None, request_id)
    }

    fn publish_event(&self, rt: &mut TabRuntime, mut payload: Payload, subagent: Option<SubagentRef>, prompt_request_id: Option<uuid::Uuid>) -> AgentEvent {
        if matches!(&payload, Payload::Error { .. } | Payload::TurnCompleted { status: TurnStatus::Error, .. } | Payload::ApiRetry { .. } | Payload::RateLimited { .. } | Payload::PermissionDenied { .. })
            || matches!(&payload, Payload::ToolCallCompleted { result, .. } if result.is_error) {
            recovery::diagnose(&rt.diagnostics_path(), &payload);
            recovery::sanitize(&mut payload);
        }
        if subagent.is_none() {
            rt.turn_usage.apply(&mut payload);
            match crate::checkpoints::observe(&rt.session_id, &rt.tab_id, rt.seq + 1, &mut payload) {
                Ok(Some(checkpoint)) => { self.publish(rt, Payload::TurnCheckpoint { seq: checkpoint.seq, base: checkpoint.base, head: checkpoint.head }, None); }
                Err(error) => log::warn!("capture turn checkpoint: {error:#}"),
                _ => {}
            }
        }
        rt.seq += 1;
        let mut ts = rt.source_timestamp.clone().unwrap_or_else(index::now);
        let block_key = |block: &BlockRef| format!("{}:{}:{}", subagent.as_ref().map_or("", |agent| agent.id.as_str()), block.message_id, block.index);
        match &payload {
            Payload::Delta(Delta::TextDelta { block, .. }) => {
                ts = rt.message_times.entry(block_key(block)).or_insert(ts).clone();
            }
            Payload::AssistantText { block: Some(block), .. } => {
                if let Some(first) = rt.message_times.remove(&block_key(block)) {
                    ts = first;
                }
            }
            Payload::TurnCompleted { .. } | Payload::UserMessage { queued: false, .. } if subagent.is_none() => rt.message_times.clear(),
            _ => {}
        }
        let ev = AgentEvent {
            id: uuid::Uuid::now_v7().to_string(),
            session_id: rt.session_id.clone(),
            tab_id: rt.tab_id.clone(),
            harness: rt.harness.clone(),
            seq: rt.seq,
            message_ts: (!ts.is_empty() && matches!(&payload,
                Payload::UserMessage { .. } | Payload::AssistantText { .. }
                | Payload::TurnCompleted { .. } | Payload::Delta(Delta::TextDelta { .. })
            )).then(|| ts.clone()),
            ts,
            subagent,
            prompt_request_id,
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
        match store::message_activity::record(&ev) {
            // A message to an archived session brings it back to the list
            // (#718), whoever sent it: the window, the CLI, a phone, a guest,
            // an automation or a pipeline. Only a new one does: a message
            // read again from a transcript does not move its time on.
            Ok(Some(session)) if session.archived && ev.subagent.is_none() && matches!(&ev.payload, Payload::UserMessage { .. }) => {
                self.sink.emit("session_updated", &crate::session_archive::bring_back(session));
            }
            Ok(Some(session)) => self.sink.emit("session_updated", &session),
            Ok(None) => {}
            Err(error) => log::warn!("record message activity: {error:#}"),
        }
        // The turns incidents are told against (#815), as the log has them.
        if ev.subagent.is_none() {
            match &ev.payload {
                Payload::UserMessage { queued: false, .. } if !rt.incidents.turn_open() => {
                    rt.incident_agent();
                    rt.incident(|incidents, ctx| incidents.turn_started(ctx, ev.seq, "prompt"));
                }
                Payload::TurnStarted { .. } if !rt.incidents.turn_open() => {
                    rt.incident_agent();
                    rt.incident(|incidents, ctx| incidents.turn_started(ctx, ev.seq, "agent"));
                }
                Payload::TurnCompleted { status, .. } => rt.incident(|incidents, ctx| incidents.turn_ended(ctx, ev.seq, *status)),
                _ => {}
            }
        }
        // When a bot at Full access is at work (PRO-502): a mention from the owner's account
        // written then is not taken as the owner's, since the bot posts with their login.
        if let Some(bot) = rt.acting_bot.as_deref() {
            match &ev.payload {
                Payload::UserMessage { queued: false, .. } | Payload::TurnStarted { .. } | Payload::ToolCallStarted { .. } => crate::bots::channels::working(bot, &rt.session_id, &rt.tab_id),
                Payload::TurnCompleted { .. } if ev.subagent.is_none() => {
                    crate::bots::channels::worked(&rt.session_id, &rt.tab_id);
                    // A reply may be owed to Slack or Telegram (PRO-481): only noted here, for the pump.
                    crate::bots::chat_apps::turn_ended(bot, &rt.session_id, &rt.tab_id);
                }
                _ => {}
            }
        }
        self.observer.agent_event(&ev);
        self.sink.emit("agent_event", &ev);
        ev
    }

    /// The agent's provider refused the sign-in it was launched with (#667).
    /// In a cloud workspace, the organization grant it started on is
    /// reported, so the service can refresh it or say it needs a sign-in.
    fn sign_in_refused(&self, rt: &TabRuntime) {
        crate::cloud_grants::reject_launch(&rt.launch_key());
    }

    /// `source`: the evidence the warning stands on, for its incident (#815).
    fn needs_recovery(&self, rt: &mut TabRuntime, kind: RecoveryKind, source: crate::recovery_log::Source) {
        rt.recovery = Some(kind);
        // Whatever is reported here replaces the watcher's guess, if there
        // was one; the watcher marks its own after this returns.
        rt.stalled_at = None;
        let event = self.publish(rt, Payload::Recovery { kind: Some(kind) }, None);
        rt.incident_agent();
        rt.incident(|incidents, ctx| incidents.raised(ctx, kind, source, event.seq));
        self.set_status(rt, TabStatus::Waiting);
        self.schedule_held(rt);
    }

    /// Take the tab's warning down, published and noted with `cause` (#815).
    /// The caller has already let go of `rt.recovery`.
    fn recovery_cleared(&self, rt: &mut TabRuntime, cause: &'static str) {
        let event = self.publish(rt, Payload::Recovery { kind: None }, None);
        rt.incident(|incidents, ctx| incidents.cleared(ctx, cause, event.seq));
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
            self.recovery_cleared(rt, "stall_disproved");
        }
    }

    /// Evidence from the CLI, not from writing bytes into its input. Keep
    /// startup recovery and continuation receipts separate: continuations
    /// require a matching echo or a submit hook after their Enter was written.
    fn delivery_confirmed(&self, rt: &mut TabRuntime) {
        let mut accepted = None;
        if let Engine::Cli(p) = &mut rt.engine {
            accepted = p.awaiting_delivery.take().zip(p.delivery_sent_at.take());
            p.accept_by = None;
            p.nudge_by = None;
            p.nudges_left = 0;
            p.entered_at = None;
            p.ready.mark();
        }
        if let Some((seq, sent_at)) = accepted {
            recovery::diagnose_delivery(&rt.diagnostics_path(), seq, "accepted", sent_at.elapsed(), serde_json::json!({ "queued": false }));
            recovery::diagnose_send(&rt.diagnostics_path(), seq, "delivered", serde_json::json!({ "since_sent_ms": sent_at.elapsed().as_millis() as u64 }));
        }
        self.stall_disproved(rt);
        if rt.recovery == Some(RecoveryKind::DeliveryUnconfirmed) {
            if rt.turn_open && rt.pending.is_empty() {
                self.set_status(rt, TabStatus::InProgress);
            } else {
                rt.recovery = None;
                self.recovery_cleared(rt, "delivery_confirmed");
            }
        }
    }

    /// Queued prompts the CLI was given and never took: say so once, on a
    /// tab with nothing else to say. The prompts stay in the chat as sent;
    /// nothing is typed again, because where they are now is not known.
    fn queued_prompts_unsent(&self, rt: &mut TabRuntime, unsent: &[u64]) -> bool {
        for seq in unsent {
            recovery::diagnose_delivery(&rt.diagnostics_path(), *seq, "unconfirmed", std::time::Duration::ZERO, serde_json::json!({ "queued": true }));
        }
        if unsent.is_empty() || rt.turn_open || rt.recovery.is_some() {
            return false;
        }
        self.needs_recovery(rt, RecoveryKind::DeliveryUnconfirmed, crate::recovery_log::Source::Delivery);
        true
    }

    fn set_status(&self, rt: &mut TabRuntime, status: TabStatus) {
        // A failed launch also completes a turn and settles to idle. Keep its
        // reason until work actually starts again.
        if status == TabStatus::InProgress { rt.setup_failed = false; }
        if status != TabStatus::Waiting {
            rt.stalled_at = None;
            if rt.recovery.take().is_some() {
                // What took it down, as far as this can tell: the agent's
                // own progress a moment ago, a send or a recovery that set
                // it working again, or its turn's end.
                let recent = rt.incidents.last_progress().is_some_and(|(age, _)| age < Duration::from_secs(2));
                let cause = match status {
                    TabStatus::InProgress if recent => "progress",
                    TabStatus::InProgress => "resumed",
                    _ if !rt.turn_open => "turn_ended",
                    _ => "status",
                };
                self.recovery_cleared(rt, cause);
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
        // A failure to record is reported by the activity store, once (#767).
        if let Some(total) = store::activity::transition(&rt.key(), status, source) {
            // #110's reminder can subscribe without scanning transcripts
            // or treating hydration/tab creation as fresh usage.
            self.sink.emit("agent_work_started", &total);
            self.observer.work_started(total as u64);
        }
    }

    fn announce_display_status(&self, rt: &mut TabRuntime, status: TabStatus) -> bool {
        if rt.status == status { return false; }
        rt.status = status;
        self.observer.tab_status(rt.key(), status);
        self.sink.emit("tab_status", &TabStatusEvent { session_id: rt.session_id.clone(), tab_id: rt.tab_id.clone(), status });
        true
    }

    fn set_display_status(&self, rt: &mut TabRuntime, status: TabStatus) {
        if !self.announce_display_status(rt, status) { return; }
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
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        // Lifecycle reads and admission share the existing per-tab ordering
        // gate. A backend restart must not replay unresolved starts as live.
        let mut latest: Vec<AgentEvent> = store::read_lines(&path)?;
        let seen: std::collections::HashSet<_> = latest.iter().map(|event| event.id.clone()).collect();
        // Preserve in-memory lapsed decisions even if their legacy append
        // failed. This feature does not change that publication contract.
        latest.extend(events.into_iter().filter(|event| !seen.contains(&event.id)));
        latest.sort_by_key(|event| event.seq);
        events = latest;
        // A live claim can have published its prompt but not yet its final
        // snapshot. A history read must never write that item back after it.
        if rt.held_queue.sending.is_none() && held::Queue::replay(&events) != rt.held_queue {
            let queue = rt.held_queue.clone();
            match self.save_held(&mut rt, queue.clone()) {
                Ok(event) => events.push(event),
                Err(error) => {
                    log::warn!("persist restored held queue while reading history: {error:#}");
                    // Reading a transcript still shows the safe restored state,
                    // including a paused claim, when the disk cannot save it.
                    let event = Self::held_event(&rt, queue);
                    rt.seq = event.seq;
                    events.push(event);
                }
            }
        }
        self.reconcile_input_waits(&mut rt, &mut events);
        self.reconcile_compactions(&mut rt, &mut events)?;
        for event in &mut events { recovery::sanitize(&mut event.payload); }
        // A tab that is a terminal has no agent to recover.
        let tab = index::get(session_id).ok().and_then(|entry| entry.tab(tab_id).cloned());
        let terminal = tab.as_ref().is_some_and(TabEntry::is_terminal);
        if rt.status == TabStatus::Idle && !rt.turn_open && !rt.stopping && !terminal {
            if let Some(kind) = recovery::from_history(&events) {
                let kind = match &tab {
                    Some(tab) if codex_stdio::selected(tab) => codex_stdio::recovery_on_open(tab, &path, kind),
                    _ => kind,
                };
                self.needs_recovery(&mut rt, kind, crate::recovery_log::Source::History);
            }
        }
        Ok(events)
    }

    /// End the input-box waits the log leaves open that no delivery is
    /// waiting on any more (#722): the app quit or crashed mid-wait, and the
    /// message would otherwise say for good that it is waiting. Like lapsed
    /// permission cards, the end is published, so a reload agrees.
    fn reconcile_input_waits(&self, rt: &mut TabRuntime, events: &mut Vec<AgentEvent>) {
        let mut open: Vec<u64> = Vec::new();
        for event in events.iter().filter(|event| event.subagent.is_none()) {
            match &event.payload {
                Payload::InputOccupied { prompt_seq, occupied: true, .. } if !open.contains(prompt_seq) => open.push(*prompt_seq),
                Payload::InputOccupied { prompt_seq, occupied: false, .. } | Payload::PromptWithdrawn { prompt_seq, .. } => open.retain(|seq| seq != prompt_seq),
                _ => {}
            }
        }
        let waiting = match &rt.engine {
            Engine::Cli(p) => p.input.marks.clone(),
            _ => Vec::new(),
        };
        for prompt_seq in open.into_iter().filter(|seq| !waiting.contains(seq)) {
            events.push(self.publish(rt, Payload::InputOccupied { prompt_seq, occupied: false, choice: false }, None));
        }
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

    /// What `terminalx wait` goes by. A tab with no runtime has nothing
    /// running and nothing to answer.
    pub fn wait_view(&self, session_id: &str, tab_id: &str) -> WaitView {
        let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned();
        let Some(runtime) = runtime else {
            return WaitView { status: TabStatus::Idle, asks: false, recovery: None, queued: false, running: false };
        };
        let rt = runtime.lock().unwrap();
        let (pane_running, held) = match &rt.engine {
            Engine::Cli(cli) => (self.terminals.is_running(&cli.pane_id), !cli.held.is_empty() || cli.resend_after_abort.is_some()),
            _ => (false, false),
        };
        WaitView {
            status: rt.status,
            asks: !rt.pending.is_empty(),
            recovery: rt.recovery,
            queued: held || !rt.queued.is_empty() || !rt.held_queue.items.is_empty(),
            running: rt.child.is_some() || pane_running,
        }
    }

    /// Put a tab where `wait` reads it, as its agent would: for tests of
    /// what waits on several tabs.
    #[cfg(test)]
    pub(crate) fn set_wait_state_for_tests(&self, session_id: &str, tab_id: &str, status: TabStatus, asks: bool) {
        let runtime = self.runtime(session_id, tab_id).unwrap();
        let mut rt = runtime.lock().unwrap();
        rt.pending.clear();
        if asks {
            rt.pending.insert("ask".into(), PendingAsk { tool_use_id: "tool".into(), tool_name: "Bash".into(), input: serde_json::json!({}), suggestions: Vec::new() });
        }
        self.set_display_status(&mut rt, status);
    }

    /// An agent's question card open on a tab, as its agent's `tool` would raise one.
    #[cfg(test)]
    pub(crate) fn put_question_for_tests(&self, session_id: &str, tab_id: &str, tool: &str, input: serde_json::Value) {
        let runtime = self.runtime(session_id, tab_id).unwrap();
        runtime.lock().unwrap().pending.insert(format!("question-{tab_id}"), PendingAsk { tool_use_id: "tool".into(), tool_name: tool.into(), input, suggestions: Vec::new() });
    }

    /// Hold tab `tab_id`'s lock on a thread of its own, as a slow launch does, until the sender is dropped or sent to.
    #[cfg(test)]
    pub(crate) fn hold_tab_for_tests(&self, session_id: &str, tab_id: &str) -> std::sync::mpsc::Sender<()> {
        let runtime = self.runtime(session_id, tab_id).unwrap();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let (held, is_held) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _rt = runtime.lock().unwrap();
            held.send(()).ok();
            released.recv().ok();
        });
        is_held.recv().unwrap();
        release
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

    /// A pipeline may borrow a checkout only after all accepted or queued
    /// prompts have settled, including prompts held by a PTY-first provider.
    pub fn pipeline_idle(&self, session_id: &str, tab_id: &str) -> bool {
        let Some(runtime) = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned() else { return true };
        let runtime = runtime.lock().unwrap();
        !runtime.turn_open && !runtime.stopping && runtime.pending.is_empty() && runtime.queued.is_empty()
            && match &runtime.engine {
                Engine::Cli(cli) => cli.held.is_empty() && cli.awaiting_delivery.is_none() && cli.resend_after_abort.is_none(),
                _ => true,
            }
    }

    /// Publish into a tab's transcript from outside its harness: the cloud
    /// runtime's own notes (a follow-up dropped by a stop, a turn that ended
    /// with the runtime).
    pub fn publish_external(&self, session_id: &str, tab_id: &str, payload: Payload) -> Result<AgentEvent> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        Ok(self.publish(&mut rt, payload, None))
    }

    /// Whether the tab's agent has no way to sign in in this cloud workspace
    /// (PRO-78). One running on a credential it started with keeps it.
    pub fn sign_in_required(&self, session_id: &str, tab_id: &str, harness: &str) -> Option<crate::cloud_grants::SignInRequired> {
        let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned();
        let launch = runtime.map_or_else(|| key_of(session_id, tab_id), |runtime| runtime.lock().unwrap().launch_key());
        crate::cloud_grants::sign_in_required_for_launch(harness, &launch)
    }

    /// Whether an earlier stop of this tab is still unconfirmed: retained
    /// launches a Stop has to finish before anything is removed (#467).
    pub(crate) fn stop_unconfirmed(&self, session_id: &str, tab_id: &str) -> bool {
        let key = key_of(session_id, tab_id);
        if self.stopping_ptys.lock().unwrap().get(&key).is_some_and(|panes| panes.iter().any(pty::StoppingPane::pending)) { return true; }
        let runtime = self.tabs.lock().unwrap().get(&key).cloned();
        if runtime.is_some_and(|runtime| runtime.lock().unwrap().stopping) { return true; }
        let pane = index::get(session_id).ok().and_then(|entry| entry.tab(tab_id).map(TabEntry::pane_id)).unwrap_or_else(|| Self::pane_id(tab_id));
        !self.terminals.detached_stops(&pane).is_empty()
    }

    #[cfg(test)]
    pub(crate) fn set_status_for_test(&self, session_id: &str, tab_id: &str, status: TabStatus) {
        let runtime = self.runtime(session_id, tab_id).unwrap();
        let mut rt = runtime.lock().unwrap();
        self.set_status(&mut rt, status);
    }

    /// Runs `f` while another thread holds the tab's lock, as a tab mid-launch or wedged would.
    #[cfg(test)]
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn while_tab_locked_for_test<T>(&self, session_id: &str, tab_id: &str, f: impl FnOnce() -> T) -> T {
        let runtime = self.runtime(session_id, tab_id).unwrap();
        let (held, release) = (std::sync::mpsc::channel::<()>(), std::sync::mpsc::channel::<()>());
        let holder = std::thread::spawn(move || {
            let _rt = runtime.lock().unwrap();
            held.0.send(()).unwrap();
            let _ = release.1.recv();
        });
        held.1.recv().unwrap();
        let out = f();
        release.0.send(()).unwrap();
        holder.join().unwrap();
        out
    }

    #[cfg(test)]
    pub(crate) fn status_for_test(&self, session_id: &str, tab_id: &str) -> TabStatus {
        self.runtime(session_id, tab_id).unwrap().lock().unwrap().status
    }

    /// Where process `pid` runs among this runtime's panes and agents
    /// (PRO-468), placed as `serve_cli::consent::judge` places a runtime's
    /// own: up its ancestry to a pane's process or a native agent's child;
    /// else by its session's leader, which a process reparented to launchd
    /// still keeps; else by its controlling terminal, when exactly one pane
    /// has it. Matched in memory, with no tab's lock taken: the index is read
    /// only to name the session of a pane that matched, and a failed read is
    /// an error, never "no one's". A process that made itself a new session
    /// with a terminal of its own (`script`, an existing tmux server) is no one's.
    #[cfg(unix)]
    pub(crate) fn session_of_process(&self, pid: i32) -> Result<Option<Placed>> {
        #[derive(Clone)]
        enum Root { Pane(String), Tab(String, String) }
        let mut roots: HashMap<i32, Root> = self.terminals.panes().into_iter()
            .filter_map(|pane| Some((pane.pid? as i32, Root::Pane(pane.id)))).collect();
        for (key, child) in self.children.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            if let Some((session, tab)) = key.split_once('/') {
                roots.insert(*child as i32, Root::Tab(session.to_owned(), tab.to_owned()));
            }
        }
        use crate::serve_cli::consent;
        let up = |start: i32| {
            let mut current = start;
            for _ in 0..4096 {
                if let Some(found) = roots.get(&current) {
                    return Some(found.clone());
                }
                match consent::parent_of(current) {
                    Some(parent) if parent > 1 && parent != current => current = parent,
                    _ => return None,
                }
            }
            None
        };
        let found = up(pid)
            .or_else(|| consent::session_of(pid).filter(|leader| *leader != pid && *leader > 1).and_then(up))
            .or_else(|| {
                let tty = consent::controlling_terminal(pid)?;
                let mut sharing = roots.iter().filter(|(root, _)| consent::controlling_terminal(**root) == Some(tty));
                // Several panes on one terminal say nothing about which: not placed by it.
                match (sharing.next(), sharing.next()) {
                    (Some((_, found)), None) => Some(found.clone()),
                    _ => None,
                }
            });
        Ok(match found {
            None => None,
            Some(Root::Tab(session, tab)) => Some(Placed { session: Some(session), tab: Some(tab) }),
            Some(Root::Pane(pane)) => Some(Self::place_pane(&pane)?),
        })
    }

    /// The session and tab pane `pane` belongs to: a tab's own, or another
    /// terminal of its session (`<session>:…`, a workspace setup's included),
    /// in a session with tabs or none. A pane of no session (an agent's
    /// setup) is still a TerminalX pane: placed, in no session.
    #[cfg(unix)]
    fn place_pane(pane: &str) -> Result<Placed> {
        let sessions = index::load().with_context(|| format!("read the sessions to place a process in pane {pane}"))?;
        Ok(sessions.iter().find_map(|session| {
            if let Some(tab) = session.tabs.iter().find(|tab| tab.pane_id() == pane) {
                return Some(Placed { session: Some(session.id.clone()), tab: Some(tab.id.clone()) });
            }
            pane.starts_with(&format!("{}:", session.id))
                .then(|| Placed { session: Some(session.id.clone()), tab: session.tabs.first().map(|tab| tab.id.clone()) })
        }).unwrap_or(Placed { session: None, tab: None }))
    }

    /// Keep [`Self::children`] as `rt.child_pid` says: called wherever it changes.
    fn note_child(&self, rt: &TabRuntime) {
        let mut children = self.children.lock().unwrap_or_else(|e| e.into_inner());
        match rt.child_pid {
            Some(pid) => children.insert(rt.key(), pid),
            None => children.remove(&rt.key()),
        };
    }

    pub fn is_running(&self, session_id: &str, tab_id: &str) -> bool {
        let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned();
        runtime.is_some_and(|runtime| {
            let runtime = runtime.lock().unwrap();
            runtime.child.is_some()
                || matches!(&runtime.engine, Engine::Cli(cli) if self.terminals.is_running(&cli.pane_id))
        })
    }

    /// Serialize selection with agent launch. A live CLI keeps its original
    /// MCP command until it exits; changing the picker must never reroute it.
    pub fn select_computer(&self, session_id: &str, tab_id: &str, conversation: Option<String>, target: Option<crate::computer_targets::Target>) -> Result<crate::computer_targets::Selection> {
        let runtime = self.runtime(session_id, tab_id)?;
        let runtime = runtime.lock().unwrap();
        if runtime.child.is_some() || matches!(&runtime.engine, Engine::Cli(cli) if self.terminals.is_running(&cli.pane_id)) {
            bail!("Stop this tab's agent before changing its desktop attachment. Its current tools remain bound to the original computer.");
        }
        if let Some(target) = &target { crate::computer_targets::validate_attachment(target,session_id,tab_id,conversation.clone())?; }
        index::update_tab(session_id, tab_id, |tab| crate::computer_targets::save(tab, conversation, target))
    }

    /// Whether the tab is `waiting` on nothing but a recovery it shows: an
    /// agent with no terminal (native Codex, ACP, OpenCode) whose turn ended
    /// on a failure, a refused sign-in say, with its connection still up, no
    /// turn and no ask. A send goes straight in and clears the recovery, as
    /// the desktop's own does (#644). A CLI's `waiting` can be its own prompt
    /// on screen, which nothing is typed into.
    pub fn waits_only_on_recovery(&self, session_id: &str, tab_id: &str) -> bool {
        let Some(runtime) = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned() else { return false };
        let rt = runtime.lock().unwrap();
        rt.status == TabStatus::Waiting && rt.recovery.is_some() && !rt.turn_open && rt.pending.is_empty() && !rt.stopping && rt.stdio_retiring.is_none()
            && matches!(rt.engine, Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_))
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

    /// Local lifetime cannot use the cloud activity silence budget: even a
    /// silent turn or a queued follow-up must survive a detached window.
    pub(crate) fn mobile_driver_changed(&self, session: &str, tab: &str, active: bool) {
        self.sink.emit("mobile_terminal_driver", &serde_json::json!({"sessionId":session,"tabId":tab,"active":active}));
    }

    pub(crate) fn has_background_work(&self) -> bool {
        if self.mobile.has_pending() { return true; }
        if !self.session_stop_pids.lock().unwrap().is_empty() { return true; }
        let runtimes: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        runtimes.into_iter().any(|runtime| {
            let runtime = runtime.lock().unwrap();
            runtime.turn_open || !runtime.pending.is_empty() || !runtime.queued.is_empty()
                || runtime.stop_in_flight || runtime.restart_claim.is_some()
        })
    }

    /// Roots that may be stopped after the detached idle grace. A shell's
    /// environment and foreground job are state, so every open plain terminal
    /// and hand-started agent remains work. Only managed, settled agents qualify.
    pub(crate) fn idle_process_roots(&self) -> Option<Vec<u32>> {
        let tabs: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        let mut agent_panes = std::collections::HashSet::new();
        let mut roots = Vec::new();
        for tab in tabs {
            let tab = tab.lock().unwrap();
            if tab.turn_open || !tab.pending.is_empty() || !tab.queued.is_empty() || tab.stop_in_flight || tab.restart_claim.is_some() { return None; }
            match &tab.engine {
                Engine::Cli(cli) => {
                    if cli.by_hand.is_some() || !cli.ready.settled() || cli.awaiting_delivery.is_some() || cli.resend_after_abort.is_some() || !cli.held.is_empty() {
                        return None;
                    }
                    agent_panes.insert(cli.pane_id.clone());
                }
                Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_) => roots.extend(tab.child_pid),
                Engine::None => {}
            }
        }
        for pane in self.terminals.panes().into_iter().filter(|pane| pane.running) {
            if !agent_panes.contains(&pane.id) { return None; }
            roots.push(pane.pid?);
        }
        // Orphaned groups, including closed/replaced panes, are still work.
        if self.terminals.owned_groups().iter().any(|pid| !roots.contains(pid)) { return None; }
        Some(roots)
    }

    /// Turns in progress and permission prompts waiting, counted without
    /// copying either (the cloud activity report polls this every second).
    pub fn turn_counts(&self) -> (usize, usize) {
        self.turn_counts_at(Instant::now())
    }

    fn turn_counts_at(&self, now: Instant) -> (usize, usize) {
        let runtimes: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        runtimes.into_iter().fold((0, 0), |(active, pending), runtime| {
            let runtime = runtime.lock().unwrap();
            let running = runtime.child.is_some()
                || matches!(&runtime.engine, Engine::Cli(cli) if self.terminals.is_running(&cli.pane_id));
            let last_activity = match &runtime.engine {
                Engine::Cli(cli) => self.terminals.last_output(&cli.pane_id).map_or(runtime.last_activity, |drawn| drawn.max(runtime.last_activity)),
                _ => runtime.last_activity,
            };
            // The watcher changes the display status to Waiting after five
            // quiet minutes, without closing the turn. That guess is not a
            // reason to suspend live work (#419). Real errors and prompts
            // whose delivery is unconfirmed do not get this extension.
            let silence_warning = runtime.status == TabStatus::Waiting
                && runtime.turn_open
                && runtime.pending.is_empty()
                && runtime.stalled_at.is_some()
                && runtime.recovery == Some(RecoveryKind::Timeout);
            // An agent sitting at its sign-in screen is not working, whatever
            // its tab says (PRO-78): it must not hold off the idle suspend.
            let turn = running
                && (runtime.status == TabStatus::InProgress || silence_warning)
                && now.saturating_duration_since(last_activity) < crate::cloud_activity::MAX_TURN_SILENCE
                && crate::cloud_grants::sign_in_required_for_launch(&runtime.harness, &runtime.launch_key()).is_none();
            (active + usize::from(turn), pending + runtime.pending.len())
        })
    }

    pub(crate) fn resource_overview(&self) -> crate::status::resources::ResourceOverview {
        self.status.resources.overview(&self.terminals)
    }

    pub(crate) fn resource_sample(&self) -> Result<crate::status::resources::ResourceSnapshot> {
        self.status.resources.sample(&self.terminals)
    }

    pub(crate) fn resource_kill(&self, pane: &str, confirmed: bool) -> Result<crate::status::resources::KillResult> {
        let stop = |session: &str, tab: &str| self.stop_if_idle(session, tab, crate::idle_agents::STOPPED_FROM_RESOURCES, Duration::ZERO);
        self.status.resources.kill(&self.terminals, pane, confirmed, &stop)
    }

    /// The usage windows, for an orchestration run's budget.
    pub(crate) fn usage_windows(&self) -> Vec<crate::status::usage::UsageWindow> {
        self.status.usage.windows()
    }

    pub fn usage_snapshot(&self) -> crate::status::usage::UsageSnapshot {
        self.status.usage.snapshot(&self.running_agents())
    }

    /// Refresh in the session owner so account generations, provider backoff and
    /// live hook samples share the same store across desktop attachments.
    pub fn refresh_usage(&self, manual: bool) -> crate::status::usage::UsageSnapshot {
        let cadence = crate::store::settings::load().status_bar.usage_refresh_ms();
        // The store logs every refresh: what arrived, what it kept, any failure.
        let _ = self.status.usage.refresh_claude(manual, cadence);
        // A slow Codex app-server must not delay publishing Claude's rollover.
        self.emit_usage();
        let _ = self.status.usage.refresh_codex(manual, cadence);
        let snapshot = self.usage_snapshot();
        self.sink.emit(crate::status::usage::EVENT, &snapshot);
        snapshot
    }

    pub fn reset_codex_usage(&self) -> Result<crate::status::usage::UsageSnapshot> {
        self.status.usage.reset_codex()?;
        let snapshot = self.usage_snapshot();
        self.sink.emit(crate::status::usage::EVENT, &snapshot);
        Ok(snapshot)
    }

    fn emit_usage(&self) {
        self.sink.emit(crate::status::usage::EVENT, &self.usage_snapshot());
    }

    pub fn pending_permissions(&self) -> Vec<PendingPermission> {
        self.pending_permissions_as(true)
    }

    /// [`Self::pending_permissions`] without waiting: a tab whose lock is held (a launch in progress, which can take
    /// seconds) gives what the last such read found on it (up to a minute old), so a read of what waits on the owner
    /// never waits behind it, and a question there does not drop out for one read.
    pub fn pending_permissions_now(&self) -> Vec<PendingPermission> {
        self.pending_permissions_as(false)
    }

    fn pending_permissions_as(&self, wait: bool) -> Vec<PendingPermission> {
        let runtimes: Vec<(String, Arc<Mutex<TabRuntime>>)> = self.tabs.lock().unwrap().iter().map(|(key, runtime)| (key.clone(), runtime.clone())).collect();
        let mut out = Vec::new();
        // Read without waiting: what each tab holds now, `None` for a tab whose lock is held. The memory of earlier
        // reads is taken only after, briefly, and never by a read that waits (PRO-498 review).
        let mut read: Vec<(String, Option<Vec<PendingPermission>>)> = Vec::new();
        for (key, runtime) in runtimes {
            let runtime = if wait {
                runtime.lock().unwrap()
            } else {
                match runtime.try_lock() {
                    Ok(runtime) => runtime,
                    Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
                    Err(std::sync::TryLockError::WouldBlock) => {
                        read.push((key, None));
                        continue;
                    }
                }
            };
            let found = Self::pending_of(&runtime);
            if wait {
                out.extend(found);
            } else {
                read.push((key, Some(found)));
            }
        }
        if !wait {
            // A tab whose lock is held gives what the last such read found on it, at most `PENDING_MEMORY` old, so a
            // question does not drop out of Needs you for one read and come back, nor linger once answered meanwhile.
            let now = std::time::Instant::now();
            let mut last = LAST_PENDING.lock().unwrap_or_else(|error| error.into_inner());
            last.retain(|key, (at, _)| now.duration_since(*at) <= pending_memory() && read.iter().any(|(live, _)| live == key));
            for (key, found) in read {
                match found {
                    Some(found) => {
                        if found.is_empty() {
                            last.remove(&key);
                        } else {
                            last.insert(key, (now, found.clone()));
                        }
                        out.extend(found);
                    }
                    None => out.extend(last.get(&key).map(|(_, found)| found.clone()).unwrap_or_default()),
                }
            }
        }
        out.sort_by(|a, b| a.request_id.cmp(&b.request_id));
        out
    }

    fn pending_of(runtime: &TabRuntime) -> Vec<PendingPermission> {
        let mut found = Vec::new();
        for (request_id, pending) in &runtime.pending {
            let mut options = vec!["allow".to_string(), "deny".to_string()];
            options.extend((0..pending.suggestions.len()).map(|index| format!("suggest:{index}")));
            if matches!(&runtime.engine, Engine::Cli(p) if p.decisions.get(request_id).is_some_and(|d| d.session_command.is_some())) {
                options.insert(1, crate::harness::read_only::SESSION_OPTION.to_string());
            }
            found.push(PendingPermission {
                session_id: runtime.session_id.clone(),
                tab_id: runtime.tab_id.clone(),
                request_id: request_id.clone(),
                tool_name: pending.tool_name.clone(),
                input: pending.input.clone(),
                options,
            });
        }
        found
    }

    /// The startup observer must never wait behind a child launch holding a
    /// tab lock. This is observational only; it cannot answer any prompt.
    pub(crate) fn startup_prompt_panes(&self) -> Option<Vec<String>> {
        let tabs = self.tabs.try_lock().ok()?;
        let mut panes = Vec::new();
        for runtime in tabs.values() {
            let runtime = runtime.try_lock().ok()?;
            if !runtime.pending.is_empty() { panes.push(Self::pane_id(&runtime.tab_id)); }
        }
        Some(panes)
    }

    pub fn queued(&self, session_id: &str, tab_id: &str) -> Vec<QueuedMessage> {
        self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).map(|r| r.lock().unwrap().queued.iter().map(|q| q.message.clone()).collect()).unwrap_or_default()
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
        self.accepting_work()?;
        let sink = Arc::new(TabSink { manager: self.clone(), rt: rt_arc.clone(), epoch: std::sync::atomic::AtomicU64::new(0), child: Mutex::new(None) });
        let environment = crate::store::environment::launch(cwd)?;
        let mut env: Vec<_> = environment.values.into_iter().collect();
        env.extend([
            ("RACCOON_SESSION_ID".to_string(), rt.session_id.clone()),
            ("RACCOON_TAB_ID".to_string(), rt.tab_id.clone()),
            (crate::hooks::CONTROL_SOCKET_ENV.to_string(), self.control.socket.to_string_lossy().into_owned()),
            (crate::hooks::CONTROL_TOKEN_ENV.to_string(), self.control.token.clone()),
        ]);
        // A cloud workspace's agent credentials (`cloud_grants`). Only Cursor
        // runs this way, and its grant only sets a variable.
        let harness = program.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        // The workspace's configured variables and bound secrets
        // (`cloud_config`) first, so a grant always wins.
        env.extend(crate::cloud_config::launch_config(&harness, &rt.key()).env);
        env.extend(crate::cloud_grants::agent_env_for_launch(&harness, &rt.key()).into_iter().filter_map(|(name, value)| value.map(|value| (name, value))));
        env.retain(|(key, _)| !matches!(key.as_str(), "TERMINALX_PORT" | "TERMINALX_PORTS"));
        env.extend(index::workspace_ports::environment(cwd)?);
        let child = self.host.spawn(&rt.key(), SpawnSpec { program, args, cwd: Path::new(cwd), env: &env, unset: &["TERMINALX_PORT".into(), "TERMINALX_PORTS".into()] }, sink.clone())?;
        sink.epoch.store(child.epoch, std::sync::atomic::Ordering::Release);
        *sink.child.lock().unwrap() = Some(Arc::downgrade(&child));
        rt.environment = environment.stamp;
        rt.child_pid = Some(child.pid);
        self.note_child(rt);
        self.with_provider_state(rt, |state| {
            state.binding = None;
            for context in state.operations.values().chain(state.settings.values()) { context.withdraw(); }
            state.operations.clear(); state.settings.clear();
            state.opencode.requests.clear(); state.opencode.answers.clear(); state.opencode.asks.clear(); state.opencode.preparing = None;
        });
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
        self.send_pressed(session_id, tab_id, text, images, None, Vec::new())
    }

    /// [`Self::send`] from a window's composer, which says when Send was
    /// pressed (milliseconds since the epoch, by the window's clock). The
    /// tab's diagnostics note when this runtime received it, how long it
    /// waited to be admitted and when it answered (#727), so a slow send can
    /// be traced to the step that took the time.
    ///
    /// `files` are attachments already stored for this session
    /// (`attachments::store`, PRO-290). One that is not, or is gone, refuses
    /// the send before anything is published.
    pub fn send_pressed(
        &self,
        session_id: &str,
        tab_id: &str,
        text: String,
        images: Vec<ImageInput>,
        pressed_at: Option<i64>,
        files: Vec<FileRef>,
    ) -> Result<SendOutcome> {
        self.send_pressed_with_request(session_id, tab_id, text, images, pressed_at, files, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn send_pressed_with_request(
        &self,
        session_id: &str,
        tab_id: &str,
        text: String,
        images: Vec<ImageInput>,
        pressed_at: Option<i64>,
        files: Vec<FileRef>,
        request_id: Option<uuid::Uuid>,
    ) -> Result<SendOutcome> {
        let host = crate::issue_pipeline::host::LocalHost::new(self.sink.clone(), self.clone());
        crate::issue_pipeline::engine::retry_interrupted_resolver(&host, session_id, tab_id, || {
            self.send_pressed_inner(session_id, tab_id, text, images, pressed_at, files, request_id)
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn send_pressed_inner(&self, session_id: &str, tab_id: &str, text: String, images: Vec<ImageInput>, pressed_at: Option<i64>, files: Vec<FileRef>, request_id: Option<uuid::Uuid>) -> Result<SendOutcome> {
        let files = crate::attachments::admit_refs(session_id, &files, images.len())?;
        if !files.is_empty() && tui::is_slash_command(&text) {
            bail!("A command cannot carry attached files.");
        }
        let received = Received::now(pressed_at);
        self.prepare_baseline(session_id, tab_id);
        let admission = crate::issue_pipeline::admission::lock_for(session_id, tab_id);
        let admitted = received.at.elapsed();
        let mut sharing = self.sharing.lock().unwrap();
        let outcome = if let Some(share) = sharing.sessions.get_mut(session_id) {
            share.host_takeover(tab_id, chrono::Utc::now().timestamp_millis());
            self.sink.emit("session_share_changed", &serde_json::json!({ "sessionId": session_id, "state": share.snapshot(chrono::Utc::now().timestamp_millis(), true) }));
            let host = share.host.clone();
            let outcome = self.send_admitted(&admission, session_id, tab_id, PromptText { bot: None, request_id, collaboration: collaboration_v2::current(), files, hold_if_busy: None, mobile: None, agent: text.clone(), display: text, author: Some(host), shared_connection: None }, images, None, crate::recovery_log::Origin::ShareHost);
            drop(sharing);
            outcome
        } else {
            drop(sharing);
            let origin = if pressed_at.is_some() { crate::recovery_log::Origin::Composer } else { crate::recovery_log::Origin::Programmatic };
            self.send_display_admitted(&admission, session_id, tab_id, text.clone(), text, images, files, origin, request_id)
        };
        drop(admission);
        self.forget_baseline(session_id, tab_id);
        if let Ok(outcome) = &outcome {
            self.note_received(session_id, tab_id, outcome, &received, admitted);
        }
        outcome
    }

    /// Read the checkout's tree for a prompt about to be sent, before it is
    /// admitted and with nothing held (#727). A tab mid-turn queues the prompt,
    /// which takes no baseline, so nothing is read for it.
    fn prepare_baseline(&self, session_id: &str, tab_id: &str) {
        let Ok(rt_arc) = self.runtime(session_id, tab_id) else { return };
        if rt_arc.lock().unwrap().turn_open_for_prompts() { return; }
        let Ok(entry) = index::get(session_id) else { return };
        let tree = git::snapshot_tree(Path::new(&entry.cwd)).ok();
        rt_arc.lock().unwrap().prepared_baseline = Some(PreparedBaseline { cwd: entry.cwd, tree, at: Instant::now() });
    }

    /// The tree a prompt was prepared with goes once it is sent, used or not.
    fn forget_baseline(&self, session_id: &str, tab_id: &str) {
        if let Ok(rt_arc) = self.runtime(session_id, tab_id) {
            rt_arc.lock().unwrap().prepared_baseline = None;
        }
    }

    /// When the runtime received a send, in the tab's diagnostics.
    fn note_received(&self, session_id: &str, tab_id: &str, outcome: &SendOutcome, received: &Received, admitted: Duration) {
        let Some(seq) = outcome.events.first().map(|event| event.seq) else { return };
        let Ok(rt_arc) = self.runtime(session_id, tab_id) else { return };
        let path = rt_arc.lock().unwrap().diagnostics_path();
        recovery::diagnose_send(&path, seq, "received", serde_json::json!({
            "pressed_at": received.pressed_at.and_then(chrono::DateTime::from_timestamp_millis).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            "received_at": received.wall.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "waited_ms": received.pressed_at.map(|pressed| (received.wall.timestamp_millis() - pressed).max(0)),
            "admitted_ms": admitted.as_millis() as u64,
            "answered_ms": received.at.elapsed().as_millis() as u64,
            "queued": outcome.queued,
        }));
    }

    /// The window drew a sent message (#727): when Send was pressed, when the
    /// runtime's answer reached the window and when the message was shown,
    /// by the window's clock. Noted beside the runtime's own timings of it.
    pub fn note_shown(&self, session_id: &str, tab_id: &str, seq: u64, shown: &SendShown) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let path = rt_arc.lock().unwrap().diagnostics_path();
        let stamp = |at: Option<i64>| at.and_then(chrono::DateTime::from_timestamp_millis).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        recovery::diagnose_send(&path, seq, "shown", serde_json::json!({
            "pressed_at": stamp(shown.pressed_at),
            "drawn_at": stamp(shown.drawn_at),
            "answered_at": stamp(shown.answered_at),
            "shown_at": stamp(Some(shown.shown_at)),
            "shown_ms": shown.pressed_at.map(|pressed| (shown.shown_at - pressed).max(0)),
        }));
        Ok(())
    }

    /// What a window showed of a tab's warning, or what was done in it
    /// (#815), noted with the incident the runtime knows it by.
    pub fn note_incident_ui(&self, session_id: &str, tab_id: &str, report: &crate::recovery_log::UiReport) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        rt_arc.lock().unwrap().incident(|incidents, ctx| incidents.ui(ctx, report));
        Ok(())
    }

    /// Continuations use the normal send path, but only acknowledge delivery
    /// when the provider echoes the prompt or runs its UserPromptSubmit hook.
    ///
    /// A handoff the CLI let go by is no failure (#662). It is still in the
    /// CLI's input, and is answered as that (`in_input`) for the reader to
    /// send with one Enter; its echo is then told as `delivered`. Only a
    /// handoff that is neither confirmed nor visibly in the input is an error.
    pub fn send_confirmed(&self, session_id: &str, tab_id: &str, text: String) -> Result<SendOutcome> {
        let (tx, rx) = std::sync::mpsc::channel();
        let outcome = self.send_impl(session_id, tab_id, PromptText { bot: None, request_id: None, collaboration: collaboration_v2::current(), files: Vec::new(), hold_if_busy: None, mobile: None, agent: text.clone(), display: text, author: None, shared_connection: None }, Vec::new(), Some(tx))?;
        self.confirm_continuation(session_id, tab_id, outcome, &rx)
    }

    /// A phone's Continue in New Session: the handoff goes as any phone
    /// message does, in `send_mobile`'s order (the permit before the tab), so
    /// it is held to the permit again at its write and names its sender, and
    /// is confirmed as the desktop's handoff is. A permit gone by the write
    /// delivers nothing: the receipt says so, and the tab keeps no brief to
    /// send again under the host's authority.
    pub(crate) fn send_mobile_confirmed(&self, session_id: &str, tab_id: &str, agent: String, display: String,
        permit: crate::local_runtime::mobile::WritePermit) -> Result<SendOutcome> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.prepare_baseline(session_id, tab_id);
        let outcome = (|| {
            let admission = crate::issue_pipeline::admission::lock_for(session_id, tab_id);
            let _sharing = self.sharing.lock().unwrap();
            let _admitted = permit.enter()?;
            let _privacy = permit.grant.privacy.scope()?;
            permit.check_mode(session_id, tab_id)?;
            self.send_admitted(&admission, session_id, tab_id, PromptText { bot: None, request_id: None, collaboration: collaboration_v2::current(), files: Vec::new(), hold_if_busy: None, mobile: Some(permit.clone()), shared_connection: None, author: None, agent, display }, Vec::new(), Some(tx), crate::recovery_log::Origin::Phone)
        })();
        self.forget_baseline(session_id, tab_id);
        let outcome = outcome?;
        self.confirm_continuation(session_id, tab_id, outcome, &rx)
    }

    fn confirm_continuation(&self, session_id: &str, tab_id: &str, outcome: SendOutcome, rx: &std::sync::mpsc::Receiver<std::result::Result<(), String>>) -> Result<SendOutcome> {
        let seq = outcome.events.first().map(|event| event.seq).context("the continuation was not published")?;
        let rt_arc = self.runtime(session_id, tab_id)?;
        match self.await_receipt(&rt_arc, seq, rx, ReceiptWait::DEFAULT) {
            Receipt::Delivered => Ok(outcome),
            Receipt::Failed(message) => Err(anyhow!(message)),
            Receipt::Unconfirmed => {
                let seen = self.unconfirmed_continuation(&rt_arc, seq);
                // The receipt may have come while the pane was looked at.
                if rx.try_recv() == Ok(Ok(())) {
                    return Ok(outcome);
                }
                answer_unconfirmed(seen, outcome)
            }
        }
    }

    /// Wait for a continuation's receipt for as long as its delivery is
    /// moving: the CLI coming up and the prompt being typed, then
    /// `after_enter` past the last Enter written for it (#662). Its nudges
    /// are written from here as they fall due, not a watcher pass later.
    ///
    /// The tab is only ever tried, never waited on: one whose lock is held by
    /// a write the CLI is not reading would otherwise hold this call as well,
    /// past the time its caller gives it (#661).
    fn await_receipt(&self, rt_arc: &Arc<Mutex<TabRuntime>>, seq: u64, receipt: &std::sync::mpsc::Receiver<std::result::Result<(), String>>, wait: ReceiptWait) -> Receipt {
        let limit = Instant::now() + wait.limit;
        let mut until = limit;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Receipt::Unconfirmed;
            }
            match receipt.recv_timeout(left.min(wait.poll)) {
                Ok(Ok(())) => return Receipt::Delivered,
                Ok(Err(message)) => return Receipt::Failed(message),
                // The typing is over and the echo that held the receipt is
                // gone: nothing is left that could send it.
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Receipt::Unconfirmed,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            let Ok(mut rt) = rt_arc.try_lock() else { continue };
            let now = Instant::now();
            self.nudge_if_due(&mut rt, now);
            if let Engine::Cli(p) = &rt.engine {
                // Taken on lesser evidence than a receipt (the CLI at work),
                // the prompt is no longer awaited: the receipt is close behind,
                // and the wait is not lengthened for it.
                if let (true, Some(entered)) = (p.awaiting_delivery == Some(seq), p.entered_at) {
                    let last = p.nudge_by.map_or(entered, |next| next.max(entered));
                    until = (last + wait.after_enter).min(limit);
                }
            }
        }
    }

    /// The tab's lock for a look at it, tried for up to a second rather than
    /// waited on (#661).
    fn glance(rt_arc: &Arc<Mutex<TabRuntime>>) -> Option<std::sync::MutexGuard<'_, TabRuntime>> {
        let until = Instant::now() + std::time::Duration::from_secs(1);
        loop {
            match rt_arc.try_lock() {
                Ok(rt) => return Some(rt),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(std::sync::TryLockError::WouldBlock) => return None,
            }
        }
    }

    /// A continuation nothing was heard for by the end of the wait, as its
    /// pane shows it, noted in the tab's diagnostics. `None` when the tab
    /// could not be looked at, or no longer runs a CLI.
    fn unconfirmed_continuation(&self, rt_arc: &Arc<Mutex<TabRuntime>>, seq: u64) -> Option<Unconfirmed> {
        let rt = Self::glance(rt_arc)?;
        let Engine::Cli(p) = &rt.engine else { return None };
        let unread = self.terminals.unread_input(&p.pane_id).unwrap_or(0);
        let in_input = self.terminals.read_output(&p.pane_id).is_some_and(|output| tui::shows_paste(&output, p.harness.paste_placeholder()));
        let elapsed = p.delivery_sent_at.map_or(std::time::Duration::ZERO, |at| at.elapsed());
        recovery::diagnose_delivery(&rt.diagnostics_path(), seq, "unconfirmed", elapsed, serde_json::json!({ "queued": false, "unread": unread, "in_input": in_input }));
        Some(Unconfirmed { agent: agent_name(&rt.harness), unread, in_input })
    }

    /// The reader's Enter for a continuation left in the CLI's input (#662):
    /// the handoff dialog's button, once the wait for its receipt is over.
    /// Written only where the app's own nudge would be, and acknowledged the
    /// same way: the CLI's record of the prompt, told as `delivered`.
    ///
    /// `false` when that prompt is no longer the one awaited, taken already
    /// or replaced by another; the reason, when the Enter is held back.
    pub fn submit_waiting(&self, session_id: &str, tab_id: &str, seq: u64) -> Result<bool> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if let Some(left) = self.left_the_terminal(&rt) {
            return Err(follow::Refusal(left).into());
        }
        let agent = agent_name(&rt.harness);
        let pane = match &rt.engine {
            Engine::Cli(p) if p.awaiting_delivery == Some(seq) => p.pane_id.clone(),
            // Experimental Codex has no input to leave a prompt in: Codex
            // took it or it failed, and the receipt already said which.
            Engine::Cli(_) | Engine::CodexStdio(_) => return Ok(false),
            _ => bail!("{agent} is not running in this tab."),
        };
        match self.enter_again(&mut rt, &pane, seq, Instant::now(), "reader") {
            Nudged::Written(true) => Ok(true),
            Nudged::Written(false) => bail!("Could not write to {agent}'s terminal. Press Enter there instead."),
            Nudged::Typing => bail!("Another prompt is being typed into {agent}. Try again in a moment."),
            Nudged::Asking => bail!("{agent} is asking something in its terminal. Answer it there first."),
            Nudged::Unread(_) => bail!("{agent} has stopped reading its input. Check its terminal."),
        }
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
    #[allow(clippy::too_many_arguments)]
    fn send_display_admitted(&self, admission: &crate::issue_pipeline::admission::Admitted,
        session_id: &str, tab_id: &str, text: String, display_text: String, images: Vec<ImageInput>, files: Vec<FileRef>, origin: crate::recovery_log::Origin, request_id: Option<uuid::Uuid>,
    ) -> Result<SendOutcome> {
        let outcome = self.send_admitted(admission, session_id, tab_id, PromptText { bot: None, request_id, collaboration: collaboration_v2::current(), files, hold_if_busy: None, mobile: None, agent: text, display: display_text, author: None, shared_connection: None }, images, None, origin);
        // The app declining to type into the tab's terminal is no error of
        // the agent's: nothing is raised in the tab, and the reason is said.
        if outcome.as_ref().is_err_and(|error| error.is::<follow::Refusal>()) {
            return outcome;
        }
        // Native Codex still on its turn refused the request, not the turn
        // (#815), and a command it has no request for is the same (#1498):
        // the turn goes on, nothing is raised in the tab, and the sender is
        // told why in words of its own.
        if outcome.as_ref().is_err_and(|error| error.is::<codex_stdio::Busy>() || error.is::<codex_stdio::QueueFull>() || error.is::<codex_stdio::UnsupportedCommand>()) {
            return outcome;
        }
        if let Err(error) = &outcome {
            if let Ok(rt) = self.runtime(session_id, tab_id) {
                let mut rt = rt.lock().unwrap();
                let message = format!("{error:#}");
                let kind = RecoveryKind::classify(&message);
                rt.signed_out_in_turn |= kind == RecoveryKind::SignedOut && rt.turn_open;
                // As `apply` raises an agent's error, but standing on the
                // refused request, so its incident says what it was.
                self.needs_recovery(&mut rt, kind, crate::recovery_log::Source::RequestRefused);
                self.publish(&mut rt, Payload::Error { detail: recovery::detail(&message), message, fatal: false }, None);
            }
        }
        outcome.map_err(|error| anyhow!(RecoveryKind::classify(&error.to_string()).message()))
    }

    /// Keep the device grant and tab epoch through synchronous headless input;
    /// the PTY writer takes the same permit again immediately before typing.
    pub(crate) fn send_mobile(&self, session_id: &str, tab_id: &str, text: String, display: String,
        images: Vec<ImageInput>, permit: crate::local_runtime::mobile::WritePermit) -> Result<SendOutcome> {
        // Admission precedes sharing, device grants and tab revisions. Delete
        // and stop-all hold admission while invalidating those same permits.
        self.prepare_baseline(session_id, tab_id);
        let outcome = (|| {
            let admission = crate::issue_pipeline::admission::lock_for(session_id, tab_id);
            let _sharing = self.sharing.lock().unwrap();
            let _admitted = permit.enter()?;
            let _privacy = permit.grant.privacy.scope()?;
            permit.check_mode(session_id, tab_id)?;
            self.send_admitted(&admission, session_id, tab_id, PromptText { bot: None, request_id: None, collaboration: collaboration_v2::current(), files: Vec::new(), hold_if_busy: None, mobile:Some(permit.clone()),
                shared_connection:None,author:None,agent:text,display }, images, None, crate::recovery_log::Origin::Phone)
        })();
        self.forget_baseline(session_id, tab_id);
        outcome
    }

    /// Caller acquires checkout admission before sharing/attachment authority.
    pub(crate) fn send_shared_admitted(&self, admission: &crate::issue_pipeline::admission::Admitted, session_id: &str, tab_id: &str, text: String, author: crate::local_sharing::Person, connection: crate::local_sharing::WritePermit) -> Result<SendOutcome> {
        let _privacy = connection.privacy.scope()?;
        self.send_admitted(admission, session_id, tab_id, PromptText { bot: None, request_id: None, collaboration: collaboration_v2::current(), files: Vec::new(), hold_if_busy: None, mobile: None, agent: text.clone(), display: text, author: Some(author), shared_connection: Some(connection) }, Vec::new(), None, crate::recovery_log::Origin::Share)
    }

    /// A message TerminalX puts in a bot's chat (PRO-475): another bot's hand-off, tell or answer, a mention, or the
    /// app's own note. Its agent gets `text`, exactly as given, and the transcript records the same text under
    /// `author`, never as the owner's words. `card` says what the message is (PRO-539): the window draws it from
    /// those fields, and nothing of it reaches the agent. A stopped tab starts, as any send starts it.
    pub(crate) fn send_from_bot(&self, session_id: &str, tab_id: &str, text: String, author: crate::local_sharing::Person, card: Option<crate::events::BotMessage>) -> Result<SendOutcome> {
        let admission = crate::issue_pipeline::admission::lock_for(session_id, tab_id);
        self.send_admitted(&admission, session_id, tab_id, Self::bot_prompt(text, author, card), Vec::new(), None, crate::recovery_log::Origin::Programmatic)
    }

    /// What [`Self::send_from_bot`] sends: the same text to the agent and to the transcript, with the card beside it.
    fn bot_prompt(text: String, author: crate::local_sharing::Person, card: Option<crate::events::BotMessage>) -> PromptText {
        PromptText { bot: card.map(Box::new), request_id: None, collaboration: collaboration_v2::current(), files: Vec::new(), hold_if_busy: None, mobile: None, agent: text.clone(), display: text, author: Some(author), shared_connection: None }
    }

    #[cfg(test)]
    pub(crate) fn send_shared(&self, session_id: &str, tab_id: &str, text: String, author: crate::local_sharing::Person, connection: crate::local_sharing::WritePermit) -> Result<SendOutcome> {
        let admission = crate::issue_pipeline::admission::lock_for(session_id, tab_id);
        self.send_shared_admitted(&admission, session_id, tab_id, text, author, connection)
    }

    fn send_impl(
        &self, session_id: &str, tab_id: &str, prompt: PromptText,
        images: Vec<ImageInput>, receipt: Option<DeliveryReceipt>,
    ) -> Result<SendOutcome> {
        self.prepare_baseline(session_id, tab_id);
        let admission = crate::issue_pipeline::admission::lock_for(session_id, tab_id);
        let origin = if receipt.is_some() { crate::recovery_log::Origin::Continuation } else { crate::recovery_log::Origin::Programmatic };
        let outcome = self.send_admitted(&admission, session_id, tab_id, prompt, images, receipt, origin);
        drop(admission);
        self.forget_baseline(session_id, tab_id);
        outcome
    }

    /// Every send, from wherever it came, passes here. One the tab took is a
    /// message its agent now has, which an issue pipeline stopped on its
    /// answer is waiting for (#725).
    #[allow(clippy::too_many_arguments)]
    fn send_admitted(&self, admission: &crate::issue_pipeline::admission::Admitted,
        session_id: &str, tab_id: &str, mut prompt: PromptText,
        images: Vec<ImageInput>, receipt: Option<DeliveryReceipt>, origin: crate::recovery_log::Origin,
    ) -> Result<SendOutcome> {
        // Serialize note delivery with other sends; failed admission leaves the note pending.
        let revert_send = crate::checkpoints::send_lock(session_id, tab_id);
        let _revert_send = revert_send.lock().unwrap();
        let notes = if tui::is_slash_command(&prompt.agent) { Vec::new() } else { crate::checkpoints::pending(session_id, tab_id)? };
        // The agent is handed the attached files' paths after what was typed,
        // and before any context the app adds (PRO-290).
        prompt.agent = crate::attachments::with_block(&prompt.agent, &prompt.files);
        prompt.append_agent_context(&crate::checkpoints::context(&notes));
        // What the send found, before it changed anything.
        let found = self.runtime(session_id, tab_id).ok().map(|rt| { let rt = rt.lock().unwrap(); (rt.turn_open, rt.pending.len()) });
        let outcome = self.deliver_admitted(admission, session_id, tab_id, prompt, images, receipt);
        self.note_send(session_id, tab_id, origin, found, &outcome);
        let outcome = outcome?;
        // A held follow-up has no user_message yet: it is not an answer, and
        // its revert notes stay pending until the held text is delivered.
        if let Some(event) = outcome.events.iter().find(|event| matches!(event.payload, Payload::UserMessage { .. })) {
            if let Err(error) = crate::checkpoints::acknowledge_sent(session_id, tab_id, event.seq, &notes) {
                log::warn!("acknowledge revert context: {error:#}");
            }
            self.observer.answered(session_id, tab_id);
        }
        Ok(outcome)
    }

    /// What became of a send, in the tab's incidents (#815): admitted with
    /// its prompt's seq, which its turn is told by, or refused and why. A
    /// refusal is the request's: the turn it met is not failed by it.
    fn note_send(&self, session_id: &str, tab_id: &str, origin: crate::recovery_log::Origin, found: Option<(bool, usize)>, outcome: &Result<SendOutcome>) {
        use crate::recovery_log::{Admission, Refusal};
        let Ok(rt_arc) = self.runtime(session_id, tab_id) else { return };
        let (admission, refusal, prompt_seq) = match outcome {
            Ok(sent) => (if sent.queued { Admission::Queued } else { Admission::Admitted }, None,
                sent.events.iter().find(|event| matches!(event.payload, Payload::UserMessage { .. })).map(|event| event.seq)),
            Err(error) if error.is::<codex_stdio::Busy>() || error.is::<crate::local_runtime::mobile::Busy>() => (Admission::Busy, Some(Refusal::Busy), None),
            Err(error) => {
                let said = error.to_string();
                let refusal = if error.is::<follow::Refusal>() { Refusal::LeftTerminal }
                    else if said.starts_with("Stop has not confirmed") { Refusal::Stopping }
                    else if said.contains("restarting to apply its settings") { Refusal::Restarting }
                    else { Refusal::Other };
                (Admission::Refused, Some(refusal), None)
            }
        };
        rt_arc.lock().unwrap().incident(|incidents, ctx| incidents.send(ctx, origin, admission, refusal, prompt_seq, found));
    }

    fn deliver_admitted(&self, _admission: &crate::issue_pipeline::admission::Admitted,
        session_id: &str, tab_id: &str, prompt: PromptText,
        images: Vec<ImageInput>, receipt: Option<DeliveryReceipt>,
    ) -> Result<SendOutcome> {
        self.accepting_work()?;
        crate::issue_pipeline::admission::check(session_id, tab_id)?;
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut entry = index::get(session_id)?;
        let mut tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        let mut rt = rt_arc.lock().unwrap();
        if let Some(permit) = &prompt.collaboration { Self::check_collaboration_permit(permit, &rt)?; }
        if prompt.collaboration.as_ref().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2())
            && !matches!(tab.harness.as_str(), "claude" | "codex") {
            bail!("This engine has no collaboration-v2 final writer");
        }
        // Shutdown may have fenced and cleared this runtime while the sender
        // was waiting for its lock. Do not refill a cleared follow-up queue.
        self.accepting_work()?;
        if rt.stopping { bail!("Stop has not confirmed local process exit. Retry Stop before resuming."); }
        if rt.restart_claim.is_some() { bail!("The agent is restarting to apply its settings. Try again shortly."); }
        // Admission orders app sends; the terminal can still start a turn
        // between change_held's idle check and this lock. Hold it here too.
        if let Some(send_now) = prompt.hold_if_busy.filter(|_| rt.turn_open_for_prompts()) {
            return self.enqueue_held(session_id, tab_id, &rt_arc, rt, prompt.display, images, prompt.files, send_now);
        }
        // A turn may have begun in the terminal after the queue claimed an
        // idle boundary. Held input must still never be typed mid-turn.
        if rt.held_queue.sending.is_some() {
            if rt.turn_open_for_prompts() || (rt.held_queue.paused && rt.held_queue.next.is_none()) {
                bail!("The agent started another turn or the queue was paused. The follow-up is still held; use Resume or Send now to retry.");
            }
            if let Some(reason) = rt.held_queue.blocked(&rt) { bail!(reason); }
        }
        // A CLI the reader started by hand is theirs to drive: it runs with
        // whatever permissions they gave it, which no share was checked
        // against. And a terminal is the host's to start an agent in.
        if prompt.shared_connection.is_some() && tab.by_hand() {
            bail!("This tab's agent was started by hand in its terminal. Only the host can send to it.");
        }
        if prompt.shared_connection.is_some() && tab.is_terminal() {
            bail!("No agent is running in this tab. Only the host can start one.");
        }
        // A prompt for a tab that is a terminal starts its agent again on the
        // tab's conversation, in the place of the shell.
        if tab.is_terminal() && !matches!(rt.engine, Engine::Cli(_)) {
            self.wake(&mut rt, &tab)?;
            entry = index::get(session_id)?;
            tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        }
        // What is typed for a CLI the reader started by hand lands in their
        // shell once that CLI is gone, and the watcher may be a moment behind.
        if let Some(left) = self.left_the_terminal(&rt) {
            return Err(follow::Refusal(left).into());
        }
        if prompt.mobile.is_some() && (rt.turn_open || !rt.pending.is_empty()) {
            return Err(crate::local_runtime::mobile::Busy.into());
        }
        if self.codex_stdio_falls_back(&rt, &tab)? {
            entry = index::get(session_id)?;
            tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        }
        let (refs, wire_images) = Self::archive_images(session_id, &images)?;

        if codex_stdio::selected(&tab) {
            return self.send_codex_stdio(&mut rt, &rt_arc, &entry, prompt, refs, wire_images, receipt);
        }

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

        if rt.child.is_some() && (rt.turn_open || matches!(&rt.engine, Engine::Acp(a) if a.waiting_for_session())) {
            let mut q = QueuedMessage {
                id: uuid::Uuid::now_v7().to_string(),
                text: prompt.agent.clone(),
                images: wire_images,
            };
            let ev = self.publish_prompt(
                &mut rt,
                Payload::UserMessage { author: prompt.author.clone(), bot: prompt.bot.clone(),
                    text: prompt.display,
                    images: refs,
                    files: prompt.files.clone(),
                    baseline: None,
                    queued: true,
                    cwd: Some(entry.cwd.clone()),
                },
                prompt.request_id,
            );
            let privacy = crate::data_privacy::remote_ticket();
            let binding = self.provider_binding(&rt).context("provider association missing before queue")?;
            let sender = provider_authority::SenderAuthority::capture(prompt.collaboration.clone(), provider_authority::RequiredAction::Drive,
                privacy.clone(), prompt.mobile.clone(), prompt.shared_connection.clone());
            let operation = provider_authority::OperationContext::new(sender, provider_authority::RequiredAction::Drive, binding,
                provider_authority::Correlation::Prompt { seq: ev.seq, request: q.id.clone() });
            q.id = self.with_provider_state(&rt, |state| state.queue.insert(ev.seq, operation));
            rt.queued.push(PendingMessage { message: q, privacy, seq: ev.seq });
            return Ok(SendOutcome { queued: true, events: vec![ev], in_input: false });
        }

        if rt.child.is_none() {
            match HarnessId::parse(&tab.harness) {
                HarnessId::Claude | HarnessId::Codex => bail!("that agent runs its own CLI"),
                HarnessId::Acp(binary) => self.start_acp(&mut rt, &rt_arc, &entry, &tab, &entry.cwd, &binary)?,
                HarnessId::OpenCode => self.start_opencode(&mut rt, &rt_arc, &entry, &tab, &entry.cwd)?,
                HarnessId::Other(name) => bail!("The {name} agent is not wired up yet."),
            }
        }

        let baseline = rt.baseline_for(&entry.cwd);
        let events = vec![self.publish_prompt(
            &mut rt,
            Payload::UserMessage { author: prompt.author.clone(), bot: prompt.bot.clone(),
                text: prompt.display,
                images: refs,
                files: prompt.files.clone(),
                baseline,
                queued: false,
                cwd: Some(entry.cwd.clone()),
            },
            prompt.request_id,
        )];

        let acp_delivery = acp::Delivery { seq: events[0].seq, privacy: crate::data_privacy::remote_ticket(),
            mobile: prompt.mobile.clone(), shared: prompt.shared_connection.clone() };
        let acp_waits = matches!(&rt.engine, Engine::Acp(_));
        let use_carried = (acp_waits || matches!(rt.engine, Engine::OpenCode(_)))
            && (self.carried_acp(&rt) || self.carried_opencode(&rt)
                || prompt.collaboration.as_ref().is_some_and(|p| p.collaboration.runtime_policy.is_v2()));
        if use_carried {
            use provider_authority::{SenderAuthority, RequiredAction, OperationContext, Correlation};
            let binding = self.provider_binding(&rt).context("ACP association missing at ingress")?;
            let sender = SenderAuthority::capture(prompt.collaboration.clone(), RequiredAction::Drive,
                acp_delivery.privacy.clone(), prompt.mobile.clone(), prompt.shared_connection.clone());
            let context = OperationContext::new(sender, RequiredAction::Drive, binding,
                Correlation::Prompt { seq: events[0].seq, request: uuid::Uuid::new_v4().to_string() });
            if matches!(rt.engine, Engine::OpenCode(_)) {
                self.send_opencode_carried(&mut rt, prompt.agent.clone(), wire_images, events[0].seq, context)?;
            } else {
                self.send_acp_carried(&mut rt, prompt.agent.clone(), wire_images, acp_delivery, context)?;
            }
        } else { match &mut rt.engine {
            Engine::Acp(a) => {
                let actions = if a.ready {
                    a.prompt_with_delivery(prompt.agent.clone(), wire_images, Some(acp_delivery))
                } else {
                    a.start_with_delivery(prompt.agent.clone(), wire_images, Some(acp_delivery))
                };
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => {
                o.set_prompt_seq(events[0].seq);
                let actions = if o.ready {
                    o.prompt(prompt.agent.clone(), wire_images)
                } else {
                    o.start(prompt.agent.clone(), wire_images)
                };
                self.apply_actions_with_mobile(&mut rt, actions, prompt.mobile.as_ref());
            }
            Engine::CodexStdio(_) | Engine::Cli(_) | Engine::None => bail!("no engine"),
        }
        }
        // ACP records delivery only at its admitted physical prompt write.
        if let Some(event) = events.first().filter(|_| !acp_waits) {
            recovery::diagnose_send(&rt.diagnostics_path(), event.seq, "delivered", serde_json::json!({ "since_sent_ms": 0 }));
        }
        rt.open_turn();
        rt.turn_started_at = Some(Instant::now());
        self.set_status(&mut rt, TabStatus::InProgress);
        Ok(SendOutcome { queued: false, events, in_input: false })
    }

    /// With no process, local changes become launch defaults. Remote changes
    /// retain their provenance until an admitted launch consumes them, so a
    /// privacy toggle can still withdraw them while the process is stopped.
    fn settle_settings_without_process(&self, rt: &mut TabRuntime) -> Option<Settings> {
        match self.update_settings(rt, |s| {
            let _privacy = s.admit_pending();
            s.settled_without_process();
        }) {
            Ok((_, now)) => Some(now),
            Err(error) => {
                log::warn!("settle the settings of {}/{}: {error:#}", rt.session_id, rt.tab_id);
                None
            }
        }
    }

    /// The tab as a process started now should see it: a change left waiting
    /// by a process that has since gone rides with this one.
    fn launching(&self, rt: &mut TabRuntime, tab: &TabEntry) -> Result<(TabEntry, Vec<crate::data_privacy::RemoteWrite>)> {
        let privacy = self.admit_pending_settings(rt)?;
        let (_, now) = self.update_settings(rt, |s| s.settled_without_process())?;
        let mut tab = tab.clone();
        now.write(&mut tab);
        Ok((tab, privacy))
    }

    // ACP chooses a model during its asynchronous session-opening handshake,
    // after the process was spawned. Revalidate just before handling each
    // opening reply and retain admission through the resulting stdio writes.
    // The provider's acknowledgement consumes the request via Settings::reported.
    fn prepare_acp_opening_settings(&self, rt: &mut TabRuntime) -> Result<Vec<crate::data_privacy::RemoteWrite>> {
        if !matches!(&rt.engine, Engine::Acp(a) if !a.ready) { return Ok(Vec::new()); }
        let privacy = self.admit_pending_settings(rt)?;
        let entry = index::get(&rt.session_id)?;
        let tab = entry.tab(&rt.tab_id).context("tab not found")?;
        if let Engine::Acp(a) = &mut rt.engine {
            a.model = Some(tab.requested_model.as_ref().unwrap_or(&tab.model).clone()).filter(|m| !m.is_empty());
            a.mode = tab.requested_permission_mode.as_ref().unwrap_or(&tab.permission_mode).clone();
            a.opening_model_request = Settings::of(tab).model_request_id().map(String::from);
        }
        Ok(privacy)
    }

    fn start_acp(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry, tab: &TabEntry, cwd: &str, binary: &str) -> Result<()> {
        if crate::computer_targets::chosen(tab)?.is_some() { bail!("This agent does not support the selected desktop attachment; clear it explicitly before starting"); }
        // A bot's work runs only where its rules and access reach (PRO-468).
        crate::bots::chat::refuse_unheld_launch(entry, &tab.harness)?;
        let launch_permits = Self::pending_configuration_permits(rt)?;
        let _launch_policy = launch_permits.iter().map(|permit| permit.collaboration.try_enter_admission()
            .context("ACP launch Configure policy is changing")).collect::<Result<Vec<_>>>()?;
        let (tab, _privacy) = self.launching(rt, tab)?;
        let plan = acp::spawn_plan(binary).ok_or_else(|| anyhow!("{binary} is not installed. Install it and log in, then try again."))?;
        rt.engine = Engine::Acp(acp::Acp::new(cwd, tab.provider_session_id.clone(), Some(tab.model.clone()).filter(|m| !m.is_empty()), &tab.permission_mode));
        // Leave a remote model pending until the handshake actually asks
        // the provider for it. The next reply rechecks its privacy ticket.
        let _opening = self.prepare_acp_opening_settings(rt)?;
        self.spawn_child(rt, rt_arc, &plan.program, &plan.args, cwd).with_context(|| format!("start {binary}"))?;
        Ok(())
    }

    fn start_opencode(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry, tab: &TabEntry, cwd: &str) -> Result<()> {
        if crate::computer_targets::chosen(tab)?.is_some() { bail!("This agent does not support the selected desktop attachment; clear it explicitly before starting"); }
        // A bot's work runs only where its rules and access reach (PRO-468).
        crate::bots::chat::refuse_unheld_launch(entry, &tab.harness)?;
        let launch_permits = Self::pending_configuration_permits(rt)?;
        let _launch_policy = launch_permits.iter().map(|permit| permit.collaboration.try_enter_admission()
            .context("OpenCode launch Configure policy is changing")).collect::<Result<Vec<_>>>()?;
        let (tab, _privacy) = self.launching(rt, tab)?;
        let plan = opencode::spawn_plan().ok_or_else(|| anyhow!("OpenCode is not installed. Install it and log in, then try again."))?;
        rt.engine = Engine::OpenCode(opencode::OpenCode::new(plan.port, cwd, tab.provider_session_id.clone(), Some(tab.model.clone()).filter(|m| !m.is_empty()), &tab.permission_mode));
        self.spawn_child(rt, rt_arc, &plan.program, &plan.args, cwd).context("start OpenCode")?;
        let child = rt.child.clone().context("OpenCode event association missing")?;
        let binding = self.provider_binding(rt).context("OpenCode event binding missing")?;
        let base = format!("http://127.0.0.1:{}", plan.port);
        let manager = self.clone();
        let rt_weak = Arc::downgrade(rt_arc);
        std::thread::Builder::new()
            .name("opencode-events".into())
            .spawn(move || {
                // Native association/launch only: an old remote prompt's
                // Drive revocation must not hide an independent local turn.
                let alive = || rt_weak.upgrade().is_some_and(|runtime| {
                    let rt = runtime.lock().unwrap();
                    !rt.stopping && matches!(rt.engine, Engine::OpenCode(_))
                        && rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, &child))
                        && manager.provider_binding(&rt).is_some_and(|live| binding.current(&live))
                });
                let emit = |line: String| {
                    if let Some(runtime) = rt_weak.upgrade() {
                        manager.on_opencode_event_from(&runtime, &child, &binding, &line);
                    }
                };
                opencode::pump_events(&base, alive, emit);
            })
            .context("event pump")?;
        Ok(())
    }

    fn withdraw_acp_input(&self, rt: &mut TabRuntime) {
        let actions = match &mut rt.engine { Engine::Acp(a) => a.withdraw_input(), _ => Vec::new() };
        self.apply_actions(rt, actions);
    }

    /// Re-admit the original sender outside runtime, in the same lock order
    /// as phone/share sends. The lease covers the complete physical frame.
    /// The exact child and adapter request must still own it after admission.
    fn write_acp_prompt(&self, runtime: std::sync::Weak<Mutex<TabRuntime>>, child: Option<Arc<crate::harness::host::LiveChild>>,
        session: String, tab: String, write: acp::PromptWrite) {
        let mut started = Some(write.started);
        let Some(runtime) = runtime.upgrade() else { return };
        let current = |rt: &TabRuntime| !rt.stopping
            && child.as_ref().zip(rt.child.as_ref()).is_some_and(|(sent, live)| Arc::ptr_eq(sent, live))
            && matches!(&rt.engine, Engine::Acp(a) if a.delivery_current(write.id, write.delivery.seq));
        let mut attempted = false;
        let privacy = write.delivery.privacy.as_ref()
            .or_else(|| write.delivery.mobile.as_ref().map(|p| &p.grant.privacy))
            .or_else(|| write.delivery.shared.as_ref().map(|p| &p.privacy));
        let lease = privacy.map(|ticket| ticket.enter()).transpose();
        // A complete frame has one writer. Waiting for that writer owns no
        // session/admission/sender lock, so Stop and other tabs can progress.
        let frame = child.as_ref().map(|child| child.input_frame()).transpose();
        let mut bytes = write.line.as_bytes().to_vec();
        bytes.push(b'\n');
        let mut offset = 0;
        let mut stalled_until = Instant::now() + Duration::from_secs(5);
        let result = (|| -> Result<()> {
            lease.as_ref().map_err(|error| anyhow!("{error}"))?;
            frame.as_ref().map_err(|error| anyhow!("{error}"))?;
            while offset < bytes.len() {
                let mut wait_for_capacity = false;
                {
                    let _admission = crate::issue_pipeline::admission::lock_for(&session, &tab);
                    anyhow::ensure!(privacy.is_none_or(|ticket| ticket.valid()), crate::data_privacy::MESSAGE);
                    anyhow::ensure!(Instant::now() < stalled_until, "ACP input pipe timed out; input will not be replayed");
                    let mut sharing = (write.delivery.mobile.is_some() || write.delivery.shared.is_some()).then(|| self.sharing.lock().unwrap());
                    let mut attachment = None;
                    if let Some(permit) = &write.delivery.shared {
                        let share = sharing.as_mut().and_then(|s| s.sessions.get_mut(&session)).context("Sharing ended before ACP delivery")?;
                        share.admit_at_writer(permit, &tab, chrono::Utc::now().timestamp_millis())?;
                        attachment = share.owner.as_ref().map(|owner| owner.attachment.clone());
                        let entry = index::get(&session)?;
                        anyhow::ensure!(entry.tab(&tab).is_some_and(|tab| settings::allowed_while_shared(&tab.permission_mode)), "Shared mode changed before ACP delivery");
                    }
                    if let Some(permit) = &write.delivery.mobile { permit.check_mode(&session, &tab)?; }
                    let _mobile = write.delivery.mobile.as_ref().map(|permit| permit.enter()).transpose()?;
                    let _owner = attachment.as_ref().map(|attachment| attachment.enter()).transpose()?;
                    let mut rt = runtime.lock().unwrap();
                    if !current(&rt) { return Ok(()); }
                    self.accepting_work()?;
                    crate::issue_pipeline::admission::check(&session, &tab)?;
                    match child.as_ref().context("ACP child is missing")?.try_write_stdin(&bytes[offset..]) {
                        Ok(0) => bail!("ACP input pipe closed"),
                        Ok(written) => {
                            offset += written;
                            attempted = true;
                            // Bound a stalled pipe, not the total size of an
                            // image/prompt. Cancellation is checked on every
                            // chunk even while the provider keeps reading.
                            stalled_until = Instant::now() + Duration::from_secs(5);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            wait_for_capacity = true;
                            #[cfg(test)]
                            if let Some(observed) = ACP_FULL_PIPE.lock().unwrap().take() { let _ = observed.send(()); }
                        },
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
                        Err(error) => return Err(error).context("ACP input pipe failed"),
                    }
                    if offset == bytes.len() {
                        if let Engine::Acp(a) = &mut rt.engine { a.delivered(write.id); }
                        recovery::diagnose_send(&rt.diagnostics_path(), write.delivery.seq, "delivered", serde_json::json!({ "since_sent_ms": 0 }));
                        self.apply(&mut rt, started.take().unwrap(), None);
                        self.apply(&mut rt, Payload::ModelRequestStarted, None);
                    }
                }
                if wait_for_capacity { std::thread::sleep(Duration::from_millis(5)); }
            }
            Ok(())
        })();
        let mut rt = runtime.lock().unwrap();
        // Interrupt or Stop may have retired the request between chunks.
        // Close that exact pipe even when a later request now owns the turn;
        // no subsequent frame may complete the cancelled partial JSON line.
        if attempted && offset < bytes.len() {
            if let Some(child) = &child { child.close_stdin(); }
            if child.as_ref().zip(rt.child.as_ref()).is_some_and(|(sent, live)| Arc::ptr_eq(sent, live)) {
                rt.stopping = true;
                self.needs_recovery(&mut rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
            }
        }
        // Success retired the queued write; failure may have raced Stop or
        // replacement. Never close a later turn or write into a new child.
        if let Err(error) = result {
            if child.as_ref().zip(rt.child.as_ref()).is_some_and(|(sent, live)| Arc::ptr_eq(sent, live))
                && matches!(&rt.engine, Engine::Acp(a) if a.delivery_current(write.id, write.delivery.seq)) {
                if let Engine::Acp(a) = &mut rt.engine { a.withdraw_delivery(write.id); }
                log::warn!("ACP prompt delivery stopped: {error:#}");
                self.prompt_withdrawn(&mut rt, write.delivery.seq, None);
                self.apply(&mut rt, Payload::TurnCompleted { status: TurnStatus::Aborted, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false, detail: None }, None);
            }
        }
        let deferred = if child.as_ref().zip(rt.child.as_ref()).is_some_and(|(sent, live)| Arc::ptr_eq(sent, live)) {
            match &mut rt.engine {
                Engine::Acp(a) if a.writing == Some(write.id) => { a.writing = None; std::mem::take(&mut a.deferred_writes) }
                _ => Vec::new(),
            }
        } else { Vec::new() };
        drop(frame);
        // Publish the idle writer only once its frame is available to the
        // next control; otherwise a concurrent control can fail try_lock.
        drop(rt);
        // The activation acknowledgement follows partial-frame cleanup.
        drop(lease);
        for (action, ticket) in deferred {
            let _admission = crate::issue_pipeline::admission::lock_for(&session, &tab);
            let privacy = ticket.as_ref().map(|ticket| ticket.enter()).transpose();
            let mut rt = runtime.lock().unwrap();
            if rt.stopping || !child.as_ref().zip(rt.child.as_ref()).is_some_and(|(sent, live)| Arc::ptr_eq(sent, live)) { break; }
            if privacy.is_err() || self.accepting_work().is_err() || crate::issue_pipeline::admission::check(&session, &tab).is_err() {
                if let Engine::Acp(a) = &mut rt.engine { a.discard_write(&action); }
                if let Err(error) = self.admit_pending_settings(&mut rt) { log::warn!("withdraw deferred ACP setting: {error:#}"); }
                continue;
            }
            // A newer prompt may own the pipe now. Preserve this control's
            // original authority if it has to wait for that frame too.
            if let Engine::Acp(a) = &mut rt.engine {
                if a.writing.is_some() { a.deferred_writes.push((action, ticket)); continue; }
            }
            self.apply_actions(&mut rt, vec![action]);
        }
    }

    fn with_provider_state<R>(&self, rt: &TabRuntime, run: impl FnOnce(&mut ProviderTabState) -> R) -> R {
        let mut states = self.provider_states.lock().unwrap();
        states.retain(|_, state| state.runtime.strong_count() != 0);
        let state = states.entry(rt.key()).or_insert_with(|| ProviderTabState {
            runtime: rt.me.clone(), binding: None, queue: Default::default(), acp_carried: false, opencode: OpenCodeOwner::default(), operations: HashMap::new(), settings: HashMap::new(),
        });
        if !std::sync::Weak::ptr_eq(&state.runtime, &rt.me) {
            *state = ProviderTabState { runtime: rt.me.clone(), binding: None, queue: Default::default(), acp_carried: false, opencode: OpenCodeOwner::default(), operations: HashMap::new(), settings: HashMap::new() };
        }
        run(state)
    }

    fn retire_provider(&self, rt: &TabRuntime) {
        self.provider_states.lock().unwrap().remove(&rt.key());
    }

    fn provider_binding(&self, rt: &TabRuntime) -> Option<provider_authority::ProviderBinding> {
        let child = rt.child.as_ref()?;
        self.with_provider_state(rt, |state| {
            if state.binding.as_ref().is_none_or(|binding| !binding.matches_child(child)) {
                state.binding = Some(provider_authority::ProviderBinding::owned(&rt.session_id, &rt.tab_id, child));
            }
            state.binding.clone()
        })
    }

    /// Native callback entry for future adapters. The legacy Action path never
    /// implies a remote carrier. Physical envelope integration is refused until
    /// B/C supply reviewed final writers, including deferred/retry boundaries.
    #[allow(dead_code)]
    fn apply_provider_envelope(&self, rt: &mut TabRuntime, envelope: crate::harness::ProviderAction,
        reply: &provider_authority::Correlation) -> Result<provider_authority::Attempt> {
        let Some(binding) = self.provider_binding(rt).filter(|_| !rt.stopping) else {
            envelope.context.withdraw();
            return Ok(provider_authority::Attempt::Withdrawn);
        };
        if matches!(&envelope.action, Action::Write(_) | Action::AcpPrompt(_) | Action::AcpMode { .. } | Action::Http { .. }) {
            envelope.context.withdraw();
            bail!("Provider envelope has no reviewed physical writer");
        }
        let witness = Self::collaboration_witness(rt);
        envelope.context.try_callback(&binding, reply, witness.as_ref(), |sender| {
            // Such callbacks need sender/attachment gates acquired before runtime.
            // Do not reverse the lock order or silently drop independent permits.
            anyhow::ensure!(sender.mobile.is_none() && sender.local_share.is_none(), "provider callback sender gates require adapter integration");
            Ok(())
        }, || {
            if let provider_authority::Correlation::Setting { setting, request_id, .. } = reply {
                let entry = index::get(&rt.session_id)?;
                let current = Settings::of(entry.tab(&rt.tab_id).context("tab not found")?);
                anyhow::ensure!(current.collaboration_requests().get(setting) == Some(request_id), "provider setting request was replaced");
                match envelope.action {
                    Action::Emit(Payload::ProviderSettings { signal: Signal::Accepted { setting: accepted } }) if accepted.noun() == setting => {
                        let mut settled = false;
                        self.update_settings(rt, |settings| { settled = settings.settle_provider_request(setting, request_id); })?;
                        anyhow::ensure!(settled, "provider setting request was replaced");
                    }
                    Action::AcpModelRefused { request_id: model_request, model, message } if setting == "model" => {
                        let mut refused = false;
                        self.update_settings(rt, |settings| {
                            refused = false;
                            if settings.collaboration_requests().get(setting) == Some(request_id)
                                && settings.model_request_id() == Some(model_request.as_str()) {
                                refused = settings.refused(Setting::Model, Some(&model)).is_some();
                            }
                        })?;
                        anyhow::ensure!(refused, "provider model refusal request was replaced");
                        self.publish(rt, Payload::Status { text: message, handoff: None }, None);
                    }
                    _ => bail!("Provider setting callback requires an exact supported settlement"),
                }
            } else {
                anyhow::ensure!(!matches!(&envelope.action, Action::AcpModelRefused { .. } | Action::Emit(Payload::ProviderSettings { .. })),
                    "provider setting callback lacks request correlation");
                self.apply_actions(rt, vec![envelope.action]);
            }
            Ok(())
        })
    }

    fn apply_actions(&self, rt: &mut TabRuntime, actions: Vec<Action>) {
        self.apply_actions_with_mobile(rt, actions, None);
    }

    fn apply_actions_with_mobile(&self, rt: &mut TabRuntime, actions: Vec<Action>,
        mobile: Option<&crate::local_runtime::mobile::WritePermit>) {
        for a in actions {
            if self.carried_opencode(rt) && matches!(&a, Action::Http { .. } | Action::Write(_) | Action::AcpPrompt(_) | Action::AcpMode { .. }) {
                // Only the exact original ProviderAction may reach NativeHttp.
                continue;
            }
            if self.carried_acp(rt) && matches!(&a, Action::Write(_) | Action::AcpMode { .. } | Action::AcpPrompt(_)) {
                // A carried association never downgrades a callback/control to
                // the legacy privacy-only writer. Callers must supply an exact
                // ProviderAction; automatic cleanup may retire, never remint.
                if let Engine::Acp(engine) = &mut rt.engine { engine.discard_write(&a); }
                continue;
            }
            if matches!(&a, Action::Write(_) | Action::AcpMode { .. }) {
                if let Engine::Acp(engine) = &mut rt.engine {
                    if engine.writing.is_some() {
                        engine.deferred_writes.push((a, crate::data_privacy::remote_ticket()));
                        continue;
                    }
                }
            }
            match a {
                Action::AcpMode { mode, line } => {
                    if rt.stopping { continue; }
                    let result = line.as_deref().map(|line| self.write(rt, line)).unwrap_or(Ok(()))
                        .and_then(|()| self.update_settings(rt, |s| s.reported_mode(&mode)).map(|_| ()));
                    if let Err(error) = result {
                        rt.stopping = true;
                        self.needs_recovery(rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
                        self.publish(rt, Payload::Status { text: format!("Could not apply ACP permission mode: {error:#}. Stop the agent before retrying."), handoff: None }, None);
                    }
                }
                Action::AcpPrompt(write) => {
                    if let Engine::Acp(a) = &mut rt.engine { a.writing = Some(write.id); }
                    let manager = self.clone();
                    let runtime = rt.me.clone();
                    let child = rt.child.clone();
                    let session = rt.session_id.clone();
                    let tab = rt.tab_id.clone();
                    std::thread::spawn(move || manager.write_acp_prompt(runtime, child, session, tab, *write));
                }
                Action::AcpModelRefused { request_id, model, message } => {
                    let mut dropped = None;
                    let result = self.update_settings(rt, |settings| {
                        dropped = if settings.model_request_id() == Some(request_id.as_str()) {
                            settings.refused(Setting::Model, Some(&model))
                        } else { None };
                    });
                    match result {
                        Ok(_) if dropped.is_some() => { self.publish(rt, Payload::Status { text: format!("The agent did not change the model to {model}: {message}"), handoff: None }, None); }
                        Err(error) => log::warn!("record ACP model refusal: {error:#}"),
                        _ => {}
                    }
                }
                Action::Http { generation, tag, method, url, body } => {
                    let manager = self.clone();
                    let me = rt.me.clone();
                    let privacy = crate::data_privacy::remote_ticket();
                    let mobile = mobile.cloned();
                    let child = rt.child.clone();
                    std::thread::spawn(move || {
                        #[cfg(test)] {
                            let hook = BEFORE_OPENCODE_HTTP.lock().unwrap().take();
                            if let Some(hook) = hook { hook(); }
                        }
                        let admitted = crate::data_privacy::delivery_scope(privacy.as_ref());
                        let Some(runtime) = me.upgrade() else { return };
                        let current = |rt: &TabRuntime| !rt.stopping
                            && child.as_ref().zip(rt.child.as_ref()).is_some_and(|(sent, live)| Arc::ptr_eq(sent, live))
                            && matches!(&rt.engine, Engine::OpenCode(o) if o.generation() == generation);
                        let withdraw = |unconfirmed| {
                            let mut rt = runtime.lock().unwrap();
                            if !current(&rt) { return; }
                            let Engine::OpenCode(engine) = &mut rt.engine else { return; };
                            let actions = engine.withdraw_http(&tag, unconfirmed);
                            manager.apply_actions(&mut rt, actions);
                        };
                        if admitted.is_err() || mobile.as_ref().is_some_and(|permit| !permit.valid()) {
                            withdraw(false);
                            return;
                        }
                        if !current(&runtime.lock().unwrap()) { return; }
                        let line = if let Some(permit) = &mobile {
                            use opencode::{PhysicalOutcome, WriteAdmission};
                            match opencode::perform_mobile(&tag, &method, &url, body.as_ref(),
                                || current(&runtime.lock().unwrap()), |write| {
                                    let Ok(_mobile) = permit.enter() else { return WriteAdmission::Refused; };
                                    let rt = runtime.lock().unwrap();
                                    if !current(&rt) { return WriteAdmission::Refused; }
                                    let _ = write();
                                    WriteAdmission::Admitted
                                }) {
                                PhysicalOutcome::Response { status, body } =>
                                    serde_json::json!({"raccoon_http":{"tag":tag,"status":status,"body":body}}).to_string(),
                                outcome => {
                                    withdraw(outcome == PhysicalOutcome::Unknown);
                                    return;
                                }
                            }
                        } else {
                            opencode::perform(&tag, &method, &url, body)
                        };
                        let mut rt = runtime.lock().unwrap();
                        if !current(&rt) { return; }
                        let (actions, answer) = if let Engine::OpenCode(o) = &mut rt.engine {
                            let answer = o.settle_answer(&tag, &line);
                            (o.handle(&line), answer)
                        } else { (Vec::new(), None) };
                        rt.last_activity = Instant::now();
                        rt.incidents.progress("agent_output");
                        manager.stall_disproved(&mut rt);
                        // Session opening can schedule a fallback or the
                        // original prompt. Neither may shed its sender.
                        manager.apply_actions_with_mobile(&mut rt, actions, mobile.as_ref());
                        if let Some((request, allow)) = answer {
                            manager.permission_delivered(&mut rt, &request, allow);
                            let (session, tab) = (rt.session_id.clone(), rt.tab_id.clone());
                            drop(rt);
                            manager.observer.answered(&session, &tab);
                        }
                    });
                }
                Action::Write(line) => {
                    if let Err(e) = self.write(rt, &line) {
                        if matches!(&rt.engine, Engine::Acp(_)) {
                            if let Some(child) = &rt.child { child.close_stdin(); }
                            rt.stopping = true;
                            self.needs_recovery(rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
                        }
                        self.apply(rt, Payload::Error { message: format!("Connection write failed: {e:#}"), fatal: false, detail: None }, None);
                    }
                }
                Action::Emit(p) => self.apply(rt, p, None),
                Action::ThreadReady(id) => {
                    // Ordered with this child's reply and Stop/replacement;
                    // an old detached callback cannot rename the new session.
                    if let Err(error) = index::update_tab(&rt.session_id, &rt.tab_id, |tab| {
                        tab.provider_session_id = Some(id.clone());
                        Ok(())
                    }) { log::warn!("record provider session: {error:#}"); }
                }
            }
        }
    }

    /// Escape, as the agent's own screen takes it (#427): the running turn is
    /// interrupted and the agent's process stays, so the next message does
    /// not start a new one. Says whether there was anything to interrupt;
    /// with nothing running it does nothing, and types nothing into a CLI
    /// sitting at its prompt.
    ///
    /// Nothing is settled here. The turn closes as stopped, and the tab goes
    /// idle, when the agent says it has stopped: a CLI's `Interrupt` hook or
    /// its transcript, the cancelled prompt of an ACP agent, the idle of an
    /// OpenCode session. An agent that does not answer keeps its turn, and
    /// `stop` is what is left.
    ///
    /// What the turn was asking the reader is withdrawn first: an Escape
    /// never lets a tool run that was still waiting for an answer.
    ///
    /// Queued follow-ups are not dropped; only `stop` drops them.
    /// - Claude Code and Codex hold what was typed mid-turn themselves (the
    ///   app keeps no queue for them), and Escape is theirs to act on.
    /// - An ACP or OpenCode agent has no queue: the app's is kept, and its
    ///   next message starts when the interrupted turn has ended (`apply`).
    pub fn interrupt(&self, session_id: &str, tab_id: &str) -> Result<bool> {
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if let Some(permit) = &policy { Self::check_collaboration_permit(permit, &rt)?; }
        // A hard stop already under way is ending more than the turn.
        if rt.stopping {
            return Ok(false);
        }
        let busy = rt.turn_open || !rt.pending.is_empty() || matches!(rt.status, TabStatus::InProgress | TabStatus::Waiting);
        let running = match &rt.engine {
            Engine::Cli(p) => self.terminals.is_running(&p.pane_id),
            Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_) => rt.child.is_some() && rt.turn_open,
            Engine::None => false,
        };
        if !busy || !running {
            return Ok(false);
        }
        if self.carried_opencode(&rt) {
            use provider_authority::{SenderAuthority, RequiredAction, OperationContext, Correlation};
            let binding = self.provider_binding(&rt).context("OpenCode control association missing")?;
            let context = OperationContext::new(SenderAuthority::capture(policy.clone(), RequiredAction::Drive,
                crate::data_privacy::remote_ticket(), None, None), RequiredAction::Drive, binding,
                Correlation::Control { request: uuid::Uuid::new_v4().to_string(), kind: "interrupt".into() });
            if self.opencode_opening(&rt) {
                let preparing = self.with_provider_state(&rt, |s| s.opencode.preparing.clone());
                if let Some((seq, preparing)) = preparing {
                    preparing.withdraw();
                    self.with_provider_state(&rt, |s| { s.opencode.preparing = None; s.operations.remove(preparing.operation_id()); });
                    self.prompt_withdrawn(&mut rt, seq, None);
                    rt.turn_open = false;
                }
                let originals = self.with_provider_state(&rt, |s| s.opencode.requests.values()
                    .filter(|r| matches!(r.tag.as_str(), "session_get" | "session_new")).cloned().collect::<Vec<_>>());
                let child = rt.child.clone();
                drop(rt);
                if let Some(child) = child {
                    for old in originals { self.retire_opencode_original(&rt_arc, &child, &old.context, old.generation, &old.tag); }
                }
                let manager = self.clone(); let runtime = rt_arc.clone();
                std::thread::spawn(move || manager.drain_carried_acp_queue(&runtime));
            } else {
                let Engine::OpenCode(engine) = &mut rt.engine else { unreachable!() };
                let actions = engine.interrupt();
                let staged = self.carry_opencode_actions(&mut rt, &context, None, actions)?;
                context.seal_origin();
                self.stage_opencode_actions(&mut rt, staged, None);
                drop(rt);
            }
            self.observer.interrupted(&key_of(session_id, tab_id));
            return Ok(true);
        }
        if self.carried_acp(&rt) {
            use provider_authority::{SenderAuthority, RequiredAction, OperationContext, Correlation};
            let binding = self.provider_binding(&rt).context("ACP control association missing")?;
            let opening = matches!(&rt.engine, Engine::Acp(a) if a.waiting_for_session());
            let context = OperationContext::new(SenderAuthority::capture(policy.clone(), RequiredAction::Drive,
                crate::data_privacy::remote_ticket(), None, None), RequiredAction::Drive, binding,
                Correlation::Control { request: uuid::Uuid::new_v4().to_string(), kind: "interrupt".into() });
            if opening {
                let old = self.with_provider_state(&rt, |state| state.operations.values()
                    .find(|original| matches!(original.correlation(), Correlation::Opening { .. })).cloned());
                let child = rt.child.clone();
                drop(rt);
                if let (Some(child), Some(old)) = (child, old) {
                    self.retire_acp_original(&rt_arc, &child, &old, false);
                    let manager = self.clone(); let runtime = rt_arc.clone();
                    std::thread::spawn(move || manager.drain_carried_acp_queue(&runtime));
                }
            } else {
                let Engine::Acp(a) = &mut rt.engine else { unreachable!() };
                let actions = a.interrupt_carried(context)?;
                self.stage_acp_actions(&mut rt, actions);
                drop(rt);
            }
            self.observer.interrupted(&key_of(session_id, tab_id));
            return Ok(true);
        }
        let asked = !rt.pending.is_empty();
        self.cancel_asks(&mut rt);
        // Not waiting on the reader any more; still the agent's turn until it says otherwise.
        if asked && rt.status == TabStatus::Waiting && rt.recovery.is_none() {
            self.set_status(&mut rt, TabStatus::InProgress);
        }
        let sent = match &mut rt.engine {
            // The TUI reads a bare Escape as "stop"; nothing else can reach it.
            // One the reader started by hand that has left its terminal is
            // not there to read it, and its shell is not sent it.
            Engine::Cli(p) => {
                // A message sent and not yet entered is not typed after the
                // stop: not when the box empties (#722), nor when a CLI
                // restarted for its settings is ready (#746).
                p.input.stops += 1;
                // The turn's own prompt has not begun to be typed: the CLI
                // has no turn to stop, and may still be on its first screen,
                // where a key is not "stop". Withdrawing the prompt is the
                // stop, and its delivery does that (`type_prompt`).
                let untyped = p.awaiting_delivery.is_some_and(|seq| p.echoed.iter().any(|echo| echo.seq == seq && !echo.typing));
                let pane = p.pane_id.clone();
                untyped || (self.left_the_terminal(&rt).is_none() && self.terminals.write(&pane, tui::ESCAPE).is_ok())
            }
            Engine::Acp(a) => {
                let actions = a.interrupt();
                let sent = !actions.is_empty();
                self.apply_actions(&mut rt, actions);
                sent
            }
            Engine::OpenCode(o) => {
                let actions = o.interrupt();
                let sent = !actions.is_empty();
                self.apply_actions(&mut rt, actions);
                sent
            }
            Engine::CodexStdio(engine) => {
                let actions = engine.interrupt()?;
                self.apply_codex_actions(&mut rt, actions)?;
                true
            }
            Engine::None => false,
        };
        if sent {
            self.observer.interrupted(&rt.key());
        }
        Ok(sent)
    }

    /// The turn that asked is being interrupted, or has ended as stopped:
    /// what it was waiting to be told is no longer wanted. Each request is
    /// turned down where the agent waits on it (a parked hook, an ACP
    /// request, an OpenCode permission), and its card stops offering buttons.
    fn cancel_asks(&self, rt: &mut TabRuntime) {
        let carried = self.carried_acp(rt);
        let asks: Vec<String> = rt.pending.drain().map(|(id, _)| id).collect();
        let mut actions = Vec::new();
        for request_id in &asks {
            match &mut rt.engine {
                // Dropping the sender wakes the hook, which finds its request
                // gone and answers the CLI with a denial (`ask_permission`).
                Engine::Cli(p) => drop(p.decisions.remove(request_id)),
                Engine::Acp(a) if !carried => actions.extend(a.answer(request_id, "raccoon:cancel").unwrap_or_default()),
                Engine::Acp(_) => {},
                Engine::OpenCode(o) => actions.extend(o.answer(request_id, "reject").unwrap_or_default()),
                Engine::CodexStdio(engine) => {
                    let writes = engine.cancel_asks();
                    if let Err(error) = self.apply_codex_actions(rt, writes) { log::warn!("Cancel Codex approvals: {error:#}"); }
                }
                Engine::None => {}
            }
        }
        self.apply_actions(rt, actions);
        for request_id in asks {
            self.publish(rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Cancelled".into(), automatic: true }, None);
        }
    }

    /// Ask the provider to deliver its pending input with its native Escape.
    /// The provider owns the queue: neither the selected prompt nor any other
    /// held prompt is pasted again. Acceptance, not the interrupt, removes it.
    pub fn send_queued_now(&self, session_id: &str, tab_id: &str, seq: u64) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        {
            let mut rt = rt_arc.lock().unwrap();
            if matches!(rt.engine, Engine::CodexStdio(_)) {
                if !rt.turn_open || !rt.queued.iter().any(|q| q.seq == seq) { return Ok(()); }
                if !matches!(&rt.engine, Engine::CodexStdio(engine) if engine.can_interrupt()) { return Ok(()); }
                self.cancel_asks(&mut rt);
                let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
                let actions = engine.interrupt()?;
                self.apply_codex_actions(&mut rt, actions)?;
                self.observer.interrupted(&rt.key());
                return Ok(());
            }
        }
        let tail = match &rt_arc.lock().unwrap().engine {
            Engine::Cli(p) => p.tail.clone(),
            _ => bail!("Only a Claude Code or Codex tab holds messages this way."),
        };
        // Reconcile an acceptance already on disk before sending any key.
        self.pump(&rt_arc, &tail);
        let mut rt = rt_arc.lock().unwrap();
        let Engine::Cli(p) = &rt.engine else { bail!("The agent is no longer running.") };
        if !p.held.contains(&seq) || p.resend_after_abort.is_some() || !rt.turn_open {
            return Ok(());
        }
        if rt.stopping || self.left_the_terminal(&rt).is_some() || !self.terminals.is_running(&p.pane_id) {
            bail!("The agent is no longer running. The pending message has not been resent.");
        }
        let pane = p.pane_id.clone();
        // As for Escape, withdraw any pending permission before interrupting.
        self.cancel_asks(&mut rt);
        self.terminals.write(&pane, tui::ESCAPE).context("Could not interrupt the agent; the message remains pending")?;
        if let Engine::Cli(p) = &mut rt.engine {
            p.resend_after_abort = Some(seq);
        }
        if rt.status == TabStatus::Waiting && rt.recovery.is_none() {
            self.set_status(&mut rt, TabStatus::InProgress);
        }
        self.observer.interrupted(&rt.key());
        Ok(())
    }

    pub fn cancel_queued(&self, session_id: &str, tab_id: &str, message_id: &str) -> Result<Option<QueuedMessage>> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        let pos = rt.queued.iter().position(|q| q.message.id == message_id);
        let removed = pos.map(|p| rt.queued.remove(p));
        if let Some(pending) = &removed { self.with_provider_state(&rt, |state| state.queue.cancel(pending.seq, &pending.message.id)); }
        if matches!(rt.engine, Engine::CodexStdio(_)) {
            if let Some(seq) = removed.as_ref().map(|q| q.seq) {
                rt.stdio_followups.authorities.remove(&seq);
                self.publish(&mut rt, Payload::PromptWithdrawn { prompt_seq: seq, unconfirmed: false }, None);
            }
        }
        Ok(removed.map(|q| q.message))
    }

    // Called with the runtime reservation held; never acquire runtime from
    // this map. More than one cancelled/restarting launch may remain outstanding.
    fn retain_stopping_ptys(&self, key: &str, panes: &[pty::StoppingPane]) {
        if panes.is_empty() { return; }
        let mut stopping = self.stopping_ptys.lock().unwrap();
        let retained = stopping.entry(key.to_string()).or_default();
        for pane in panes {
            if !retained.iter().any(|old| old.same_launch(pane)) { retained.push(pane.clone()); }
        }
    }

    /// Retire only this operation's confirmed handles, preserving newer work.
    /// Returns whether any other launch still needs confirmation.
    fn retire_stopping_ptys(&self, key: &str, completed: &[pty::StoppingPane]) -> bool {
        let mut stopping = self.stopping_ptys.lock().unwrap();
        if let Some(retained) = stopping.get_mut(key) {
            retained.retain(|pane| !completed.iter().any(|old| old.same_launch(pane)));
            if !retained.is_empty() { return true; }
            stopping.remove(key);
        }
        false
    }

    fn set_stopped_status(&self, rt: &mut TabRuntime) {
        if rt.recovery == Some(RecoveryKind::SignedOut) {
            // Stopping the process does not authenticate it. Keep the same
            // incident (and banner) until a new authenticated turn starts.
            self.set_display_status(rt, TabStatus::Idle);
        } else {
            self.set_status(rt, TabStatus::Idle);
        }
    }

    /// Kill the agent but keep resume state, so the next prompt resumes.
    pub fn stop(&self, session_id: &str, tab_id: &str) -> Result<()> {
        self.stop_with(session_id, tab_id, false)?;
        self.observer.automation_cancelled(session_id, tab_id, "The automation agent was stopped.");
        Ok(())
    }

    /// Stop a tab's agent, and whatever it left running, if nothing is using
    /// it: no turn, no prompt waiting to be taken or answered, no question,
    /// no restart or stop under way, and nothing drawn or done for `quiet` at
    /// least ([`Self::idle_for`]). `note` is left in its transcript first. The
    /// conversation stays, and a reply nobody has looked at stays unread. Its
    /// next prompt starts the agent again; showing the tab does not
    /// ([`Self::start_on_open`]). A terminal, and an agent a person started by
    /// hand in one, are never stopped (#696).
    pub fn stop_if_idle(&self, session_id: &str, tab_id: &str, note: &str, quiet: Duration) -> Result<AgentStop> {
        let Ok(session) = index::get(session_id) else { return Ok(AgentStop::NotRunning) };
        let Some(tab) = session.tab(tab_id) else { return Ok(AgentStop::NotRunning) };
        if tab.is_terminal() || tab.by_hand() {
            return Ok(AgentStop::NotRunning);
        }
        // Held from the look to the stop: a prompt sent meanwhile is not cut
        // off, but waits for the stop and starts the agent again. Prompts
        // for every other tab are admitted meanwhile (#727).
        use crate::issue_pipeline::admission::{fence, Kind, Scope};
        let _stopping = fence(Kind::Hold, [Scope::Tab(session_id.into(), tab_id.into())]);
        if !self.is_running(session_id, tab_id) {
            return Ok(AgentStop::NotRunning);
        }
        if self.idle_for(session_id, tab_id, Instant::now()).is_none_or(|idle| idle < quiet) {
            return Ok(AgentStop::Busy);
        }
        if let Err(error) = self.publish_external(session_id, tab_id, Payload::Status { text: note.to_string(), handoff: None }) {
            log::warn!("note in {session_id}:{tab_id} before stopping its agent: {error:#}");
        }
        self.stop_with(session_id, tab_id, true)?;
        self.observer.automation_execution_lost(session_id, tab_id, "The agent stopped before the automation run completed.");
        // Kept with the tab, so a runtime started since knows it too.
        if let Err(error) = index::set_parked(session_id, tab_id, true) {
            log::warn!("mark {session_id}:{tab_id} as stopped for sitting idle: {error:#}");
        }
        Ok(AgentStop::Stopped)
    }

    /// How long a tab's running agent has had nothing to do
    /// ([`Self::stop_if_idle`]): since it last drew anything or was last
    /// told anything. `None` while it has something to do, when it was
    /// started by hand, or when it is not running.
    pub(crate) fn idle_for(&self, session_id: &str, tab_id: &str, now: Instant) -> Option<Duration> {
        let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned()?;
        let rt = runtime.lock().unwrap();
        self.quiet(&rt, now)
    }

    /// What a tab's agent left running that stopping it would end (#696):
    /// work its Claude CLI started and has not heard back from (a background
    /// command, monitor or agent, a wakeup, a cron job: its transcript says,
    /// [`claude::background`]), or a process in its group that outlived what
    /// started it ([`crate::idle_agents::left_running`]). Between such work
    /// and the turn it wakes, an agent is as quiet as one with nothing to do.
    /// `None` when it left nothing, or is not running.
    pub(crate) fn background_work(&self, session_id: &str, tab_id: &str) -> Option<String> {
        let (watch, leader) = {
            let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned()?;
            let rt = runtime.lock().unwrap();
            let leader = match &rt.engine {
                Engine::Cli(cli) => self.terminals.pid(&cli.pane_id),
                Engine::None => None,
                Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_) => rt.child_pid,
            };
            (rt.background.clone(), leader)
        };
        // Read outside the tab's lock: it is a file, and may have grown a lot.
        if let Some(what) = watch.and_then(|watch| watch.lock().unwrap().outstanding(chrono::Utc::now())) {
            return Some(what);
        }
        crate::idle_agents::left_running(leader?)
    }

    /// A new turn may already have started by the time the previous turn's
    /// completion is delivered. Background work can also wake a later turn.
    pub(crate) fn automation_execution_continues(&self, session_id: &str, tab_id: &str) -> bool {
        let Some(runtime) = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned() else { return true };
        let watch = {
            let rt = runtime.lock().unwrap();
            if Self::automation_runtime_busy(&rt) { return true; }
            rt.background.clone()
        };
        if watch.is_some_and(|watch| watch.lock().unwrap().automation_outstanding(chrono::Utc::now()).is_some()) { return true; }
        self.background_work(session_id, tab_id).is_some()
    }

    fn automation_runtime_busy(rt: &TabRuntime) -> bool {
        rt.turn_open || rt.stopping || !rt.pending.is_empty() || !rt.queued.is_empty()
            || rt.held_queue.keeps_runtime_busy() || rt.status == TabStatus::Waiting
            || matches!(&rt.engine, Engine::Cli(cli) if cli.awaiting_delivery.is_some() || cli.resend_after_abort.is_some() || cli.echoed.iter().any(|echo| echo.queued))
    }

    /// Serialize the durable completion transition with turn admission. The
    /// potentially slow process/transcript scan is outside the tab lock, then
    /// the live state is checked again while that lock is held.
    pub(crate) fn with_automation_quiescent<T>(&self, session_id: &str, tab_id: &str, generation: Option<u64>, action: impl FnOnce() -> T) -> Option<T> {
        let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned()?;
        let observed = {
            let rt = runtime.lock().unwrap();
            if Self::automation_runtime_busy(&rt) { return None; }
            rt.seq
        };
        if self.automation_execution_continues(session_id, tab_id) { return None; }
        let rt = runtime.lock().unwrap();
        if Self::automation_runtime_busy(&rt) || rt.seq != observed || generation.is_some_and(|value| value != rt.turn_generation) { return None; }
        Some(action())
    }

    pub(crate) fn with_automation_turn<T>(&self, session_id: &str, tab_id: &str, generation: Option<u64>, action: impl FnOnce() -> T) -> Option<T> {
        let runtime = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned()?;
        let rt = runtime.lock().unwrap();
        if generation.is_some_and(|value| value != rt.turn_generation) { return None; }
        Some(action())
    }

    /// A deferred automation still owns work while its CLI waits at a prompt.
    /// Keep this status persisted so all windows and the idle reaper agree.
    pub(crate) fn automation_deferred_status(&self, session_id: &str, tab_id: &str, active: bool) {
        let Some(runtime) = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned() else { return };
        let mut rt = runtime.lock().unwrap();
        if rt.turn_open || rt.stopping || !rt.pending.is_empty() || rt.recovery.is_some() { return; }
        if !active && (!rt.queued.is_empty() || rt.held_queue.keeps_runtime_busy()
            || matches!(&rt.engine, Engine::Cli(cli) if cli.awaiting_delivery.is_some() || cli.resend_after_abort.is_some() || cli.echoed.iter().any(|echo| echo.queued))) { return; }
        if active && rt.status == TabStatus::Completed {
            self.set_display_status(&mut rt, TabStatus::InProgress);
        } else if !active && rt.status == TabStatus::InProgress {
            self.set_display_status(&mut rt, TabStatus::Completed);
        }
    }

    /// Every running agent that has nothing to do, with how long it has had
    /// nothing to do: `(session id, tab id, idle for)`.
    pub(crate) fn idle_agents(&self, now: Instant) -> Vec<(String, String, Duration)> {
        let runtimes: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        runtimes
            .into_iter()
            .filter_map(|runtime| {
                let rt = runtime.lock().unwrap();
                let quiet = self.quiet(&rt, now)?;
                Some((rt.session_id.clone(), rt.tab_id.clone(), quiet))
            })
            .collect()
    }

    fn quiet(&self, rt: &TabRuntime, now: Instant) -> Option<Duration> {
        let busy = rt.turn_open
            || rt.stopping
            || rt.stop_in_flight
            || rt.restart_claim.is_some()
            || rt.stdio_starting
            || !rt.pending.is_empty()
            || !rt.queued.is_empty()
            || rt.held_queue.keeps_runtime_busy()
            || matches!(rt.status, TabStatus::InProgress | TabStatus::Waiting);
        if busy {
            return None;
        }
        let drawn = match &rt.engine {
            Engine::Cli(cli) => {
                if cli.by_hand.is_some() || cli.awaiting_delivery.is_some() || cli.resend_after_abort.is_some() || !cli.held.is_empty() || !self.terminals.is_running(&cli.pane_id) {
                    return None;
                }
                self.terminals.last_output(&cli.pane_id)
            }
            Engine::None => return None,
            // A headless agent is running while it has its process.
            Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_) if rt.child.is_none() => return None,
            Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_) => None,
        };
        let last = drawn.map_or(rt.last_activity, |drawn| drawn.max(rt.last_activity));
        Some(now.saturating_duration_since(last))
    }

    /// The window showed the tab. Its agent is started as
    /// [`Self::ensure_started`] starts it, unless nobody is about to use it
    /// (#696): its session is archived or its workspace was removed, or the
    /// agent was stopped for sitting idle. Its transcript reads the same
    /// without one, and its next prompt (or its terminal view) starts it.
    pub fn start_on_open(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_configuration()?; }
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?;
        if !tab.is_terminal() && !tab.by_hand() && !self.is_running(session_id, tab_id) {
            let set_aside = entry.archived || entry.worktree_removed;
            if set_aside || tab.parked {
                return Ok(());
            }
        }
        // A new tab whose agent exited while starting says so to the window
        // that shows it, and is not started again behind its back (PRO-291).
        let key = key_of(session_id, tab_id);
        match self.first_starts.on_open(&key, Instant::now()) {
            OnOpen::Fail(failure) => bail!(failure),
            OnOpen::Leave => return Ok(()),
            OnOpen::Start => {}
        }
        if self.first_starts.starting(&key) {
            // Its pane's exit not yet settled by the watcher: settled here.
            if let Some(failure) = self.first_cli_gone(session_id, tab_id) {
                self.first_starts.exited(&key, failure.clone(), Instant::now());
                return match failure {
                    Some(failure) => Err(anyhow!(failure)),
                    None => Ok(()),
                };
            }
        }
        self.ensure_started(session_id, tab_id)
    }

    /// A new tab's CLI whose pane has exited: `Some(Some(why))` when it went
    /// while starting ([`recovery::startup_failure`]), `Some(None)` when it
    /// went otherwise, `None` while it runs or none was launched.
    fn first_cli_gone(&self, session_id: &str, tab_id: &str) -> Option<Option<String>> {
        let rt_arc = self.runtime(session_id, tab_id).ok()?;
        let rt = rt_arc.lock().unwrap();
        let Engine::Cli(p) = &rt.engine else { return None };
        if p.by_hand.is_some() || self.terminals.is_running(&p.pane_id) {
            return None;
        }
        Some((!rt.stopping && p.never_got_going()).then(|| self.startup_failure(&rt.harness, &p.pane_id)))
    }

    /// Why a CLI that exited while starting went, by its program's name and
    /// the last line it left in its pane.
    fn startup_failure(&self, harness: &str, pane: &str) -> String {
        let output = self.terminals.program_output(pane).or_else(|| self.terminals.read_output(pane)).unwrap_or_default();
        log::warn!("[{pane}] exited while starting a new tab");
        recovery::startup_failure(harness, &recovery::EarlyExit::read(&output))
    }

    fn stop_with(&self, session_id: &str, tab_id: &str, keep_unread: bool) -> Result<()> {
        self.mobile.invalidate_tab(session_id, tab_id);
        let key = key_of(session_id, tab_id);
        let rt_arc = self.runtime(session_id, tab_id)?;
        self.pause_held_for_stop(&mut rt_arc.lock().unwrap());
        if matches!(&rt_arc.lock().unwrap().engine, Engine::CodexStdio(_)) {
            return self.stop_codex_stdio(&rt_arc, keep_unread);
        }
        if matches!(&rt_arc.lock().unwrap().engine, Engine::Cli(p) if p.by_hand.is_some()) {
            return self.stop_by_hand(&rt_arc);
        }
        let own_pane = index::get(session_id).ok().and_then(|entry| entry.tab(tab_id).map(TabEntry::pane_id)).unwrap_or_else(|| Self::pane_id(tab_id));
        let (panes, pid) = {
            let mut rt = rt_arc.lock().unwrap();
            if rt.stop_in_flight { bail!("Stop is already in progress."); }
            rt.stop_in_flight = true;
            rt.stopping = true;
            rt.queued.clear();
            self.with_provider_state(&rt, |state| state.queue.clear());
            // Only an agent's own process: the shell of a tab that is a
            // terminal is not what Stop is for.
            let agent_pane = matches!(rt.engine, Engine::Cli(_)).then_some(&own_pane);
            let pid = rt.stopping_pid.or(rt.child_pid).or_else(|| agent_pane.and_then(|pane| self.terminals.panes().iter().find(|p| &p.id == pane).and_then(|p| p.pid)));
            for request_id in rt.pending.drain().map(|(id, _)| id).collect::<Vec<_>>() {
                self.publish(&mut rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Cancelled".into(), automatic: true }, None);
            }
            rt.stopping_pid = pid;
            // Unsent ACP prompts have no provider turn to cancel and cannot
            // be handed to the next launch as local input.
            if let Engine::Acp(a) = &mut rt.engine { a.withdraw_carriers(); }
            self.with_provider_state(&rt, |state| { for context in state.operations.values().chain(state.settings.values()) { context.withdraw(); } });
            self.withdraw_acp_input(&mut rt);
            // Settle before waiting for the OS. Late exits cannot reopen this turn.
            self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
            // Its status is settled below.
            let pane = self.let_go_of_cli(&mut rt);
            let had_cli = pane.is_some();
            if let Some(pane) = pane {
                let captured = self.terminals.begin_stop_all(&[pane]);
                self.retain_stopping_ptys(&key, &captured);
            }
            let panes = self.stopping_ptys.lock().unwrap().get(&key).cloned()
                .or_else(|| had_cli.then(Vec::new));
            crate::cloud_grants::forget_launch(&key);
            rt.child = None;
            rt.child_pid = None;
            self.note_child(&rt);
            rt.engine = Engine::None;
            self.retire_provider(&rt);
            // A headless engine's process is gone too (`let_go_of_cli` has
            // done this for a CLI's).
            self.settle_settings_without_process(&mut rt);
            // A reply nobody has read yet is still unread once its agent goes.
            if !(keep_unread && rt.status == TabStatus::Completed) {
                self.set_stopped_status(&mut rt);
            }
            (panes, pid)
        };
        let signalled = Instant::now();
        if let Some(panes) = &panes {
            if !pty::StoppingPane::wait_all(panes, RESTART_WAIT) {
                let mut rt = rt_arc.lock().unwrap();
                rt.stop_in_flight = false;
                self.needs_recovery(&mut rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
                bail!("Local PTY process exit could not be confirmed. Retry Stop before resuming.");
            }
        }
        // A cancelled earlier CLI can leave retained handles even after the
        // tab changes to a headless engine. Stop its current host as before.
        if self.host.is_live(&key) {
            self.host.kill(&key);
        } else if let Some(pid) = pid.filter(|_| panes.is_none()) {
            crate::harness::host::terminate(pid);
        }
        let deadline = signalled + STOP_CONFIRM_WAIT;
        while pid.is_some_and(crate::harness::host::is_alive) {
            if Instant::now() >= deadline {
                let mut rt = rt_arc.lock().unwrap();
                rt.stop_in_flight = false;
                self.needs_recovery(&mut rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
                bail!("Local process exit could not be confirmed. Retry Stop before resuming.");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let mut rt = rt_arc.lock().unwrap();
        rt.stop_in_flight = false;
        if self.retire_stopping_ptys(&key, panes.as_deref().unwrap_or_default()) {
            rt.stopping = true;
            self.needs_recovery(&mut rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
            bail!("Another PTY launch still needs exit confirmation. Retry Stop before resuming.");
        }
        rt.stopping = false;
        rt.stopping_pid = None;
        self.publish(&mut rt, Payload::Status { text: recovery::SESSION_CLOSED_MESSAGE.into(), handoff: None }, None);
        Ok(())
    }

    /// Closing a tab is an owner operation: confirm its agent stopped before
    /// removing the open entry, while retaining provider history for reopening.
    pub fn close_tab(&self, session_id: &str, tab_id: &str) -> Result<()> {
        // Send/queue admission and view-triggered starts cannot reopen the
        // process between its confirmed exit and removal of the open entry.
        // Fenced, so other tabs' prompts do not wait for the stop (#727).
        use crate::issue_pipeline::admission::{fence, Kind, Scope, TAB_CLOSED};
        let _closing = fence(Kind::Refuse(TAB_CLOSED), [Scope::Tab(session_id.into(), tab_id.into())]);
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).context("tab not found")?;
        let pane = tab.pane_id();
        // An agent that would not exit leaves its tab open, and the reader is
        // told whose it was and how long it was given (PRO-291).
        if let Err(error) = self.stop(session_id, tab_id) {
            if recovery::exit_unconfirmed(&format!("{error:#}")) {
                bail!(recovery::close_timed_out(agent_name(&tab.harness)));
            }
            return Err(error);
        }
        self.first_starts.forget(&key_of(session_id, tab_id));
        // A followed shell is closed by the explicit tab-close action too.
        if crate::pty::is_shell_id(&pane) {
            self.terminals.kill_and_wait_confirmed(&pane, RESTART_WAIT)?;
            self.sink.emit("pty_closed", &pane);
        }
        crate::session_ops::close_tab_entry(session_id, tab_id).map_err(anyhow::Error::msg)?;
        self.observer.automation_failed(session_id, tab_id, "Its tab was closed.");
        self.sink.emit("session_updated", &index::get(session_id)?);
        self.sink.emit("tab_state_changed", &index::tab_state()?);
        Ok(())
    }

    /// Delete only after this owner confirms the session's process groups
    /// exited. The session stays fenced through removal, so a stale window
    /// cannot launch into a directory or conversation while it is being
    /// deleted, and no other session's prompt waits for it (#727).
    pub(crate) fn delete_session(&self, session_id: &str) -> Result<()> {
        use crate::issue_pipeline::admission::{fence, Kind, Scope, SESSION_DELETED};
        let _deleting = fence(Kind::Refuse(SESSION_DELETED), [Scope::Session(session_id.into())]);
        self.accepting_work()?;
        let entry = index::get(session_id)?;
        self.stop_session_confirmed(&entry)?;
        crate::session_ops::delete_session_blocking(self.sink.as_ref(), session_id, &|_| {})
            .map_err(anyhow::Error::msg)?;
        self.tabs.lock().unwrap().retain(|_, tab| tab.lock().unwrap().session_id != session_id);
        self.session_commands.lock().unwrap().retain(|key, _| !key.starts_with(&format!("{session_id}/")));
        // A bot's chat is deleted like any other session (PRO-521): a hand-off it was working on fails, and its sender is told.
        crate::bots::handoffs::chat_deleted(self, &entry);
        Ok(())
    }

    /// The caller fences the session (`admission::fence`) across its stop and subsequent mutation.
    /// Relocation stops agents but preserves the shells the reader opened.
    /// A followed agent owns its job group, not its enclosing shell's group.
    pub(crate) fn stop_agents_confirmed(&self, entry: &index::SessionEntry) -> Result<()> {
        let key = format!("{}:agents", entry.id);
        let mut pids = self.session_stop_pids.lock().unwrap().get(&key).cloned().unwrap_or_default();
        for tab in entry.tabs.iter().filter(|tab| !tab.is_terminal()) {
            let runtime = self.runtime(&entry.id, &tab.id)?;
            let runtime = runtime.lock().unwrap();
            match &runtime.engine {
                Engine::Cli(cli) => {
                    if let Some(by) = &cli.by_hand { pids.push(by.agent.job); }
                    else { pids.extend(self.terminals.pid(&cli.pane_id)); }
                }
                _ => pids.extend(runtime.child_pid.or(runtime.stopping_pid)),
            }
        }
        pids.sort_unstable();
        pids.dedup();
        self.session_stop_pids.lock().unwrap().insert(key.clone(), pids.clone());
        let mut failures = Vec::new();
        for tab in entry.tabs.iter().filter(|tab| !tab.is_terminal()) {
            if let Err(error) = self.stop(&entry.id, &tab.id) { failures.push(error.to_string()); }
        }
        let deadline = Instant::now() + RESTART_WAIT;
        loop {
            pids.retain(|pid| crate::harness::host::group_or_process_alive(*pid));
            if pids.is_empty() { break; }
            if Instant::now() >= deadline {
                self.session_stop_pids.lock().unwrap().insert(key, pids);
                bail!("Agent exit could not be confirmed. Its conversation stayed in its original folder.");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !failures.is_empty() { bail!("Agents could not be stopped: {}", failures.join("; ")); }
        self.session_stop_pids.lock().unwrap().remove(&key);
        Ok(())
    }

    /// The caller fences the session, or its checkout, through the subsequent mutation.
    /// Failed group confirmations survive retries even after a PTY was removed.
    pub(crate) fn stop_session_confirmed(&self, entry: &index::SessionEntry) -> Result<()> {
        let tab_ids: Vec<_> = entry.tabs.iter().map(|tab| tab.id.clone()).collect();
        let mut panes = self.terminals.session_pane_ids(&entry.id, &tab_ids);
        panes.extend(entry.tabs.iter().map(TabEntry::pane_id));
        panes.sort();
        panes.dedup();
        let mut pids: Vec<_> = self.terminals.panes().into_iter()
            .filter(|pane| panes.contains(&pane.id)).filter_map(|pane| pane.pid).collect();
        for tab in &entry.tabs {
            let runtime = self.runtime(&entry.id, &tab.id)?;
            let runtime = runtime.lock().unwrap();
            pids.extend(runtime.child_pid.or(runtime.stopping_pid));
        }
        pids.extend(self.session_stop_pids.lock().unwrap().get(&entry.id).into_iter().flatten().copied());
        pids.sort_unstable();
        pids.dedup();
        self.session_stop_pids.lock().unwrap().insert(entry.id.clone(), pids.clone());
        // Continue stopping this session after an individual failure, but never
        // convert that failure to permission to remove its history.
        let mut failures = Vec::new();
        for tab in &entry.tabs {
            if let Err(error) = self.stop(&entry.id, &tab.id) { failures.push(error.to_string()); }
        }
        if let Err(error) = self.terminals.kill_all_and_wait_confirmed(&panes, RESTART_WAIT) {
            failures.push(error.to_string());
        }
        pids.retain(|pid| crate::harness::host::group_or_process_alive(*pid));
        if !pids.is_empty() {
            self.session_stop_pids.lock().unwrap().insert(entry.id.clone(), pids);
            bail!("Session processes have not all exited. Its history was kept; retry the operation after they stop.");
        }
        if !failures.is_empty() { bail!("The session could not be stopped: {}", failures.join("; ")); }
        self.session_stop_pids.lock().unwrap().remove(&entry.id);
        for pane in panes.into_iter().filter(|pane| crate::pty::is_shell_id(pane)) {
            self.sink.emit("pty_closed", &pane);
        }
        Ok(())
    }

    pub fn respond_permission(&self, session_id: &str, tab_id: &str, request_id: &str, option_id: &str) -> Result<()> {
        self.respond_permission_with(session_id, tab_id, request_id, option_id, None)
    }

    pub(crate) fn respond_permission_from_phone(&self, session_id: &str, tab_id: &str, request_id: &str,
        option_id: &str, permit: &crate::local_runtime::mobile::WritePermit) -> Result<()> {
        self.respond_permission_with(session_id, tab_id, request_id, option_id, Some(permit))
    }

    fn respond_permission_with(&self, session_id: &str, tab_id: &str, request_id: &str, option_id: &str,
        mobile: Option<&crate::local_runtime::mobile::WritePermit>) -> Result<()> {
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_approval()?; }
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.child.is_none() && !matches!(rt.engine, Engine::Cli(_)) {
            rt.pending.remove(request_id);
            self.publish(&mut rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
            self.needs_recovery(&mut rt, RecoveryKind::PermissionExpired, crate::recovery_log::Source::PermissionLapsed);
            bail!("the agent is no longer running; the request lapsed");
        }
        let ask = rt.pending.get(request_id).cloned().ok_or_else(|| anyhow!("that request is no longer open"))?;
        let session_command = if option_id == crate::harness::read_only::SESSION_OPTION {
            match &rt.engine {
                Engine::Cli(p) => p.decisions.get(request_id).filter(|d| p.harness != CliKind::Codex || d.gate == "PreToolUse").and_then(|d| d.session_command.clone()),
                _ => None,
            }.ok_or_else(|| anyhow!("that request does not offer a session command allowance"))?
        } else { String::new() };
        if self.carried_opencode(&rt) {
            use provider_authority::{SenderAuthority, RequiredAction, OperationContext, Correlation};
            let binding = self.provider_binding(&rt).context("OpenCode approval association missing")?;
            let provider_request = request_id.strip_prefix("oc:").context("OpenCode ask identity invalid")?.to_string();
            let context = OperationContext::new(SenderAuthority::capture(policy.clone(), RequiredAction::Approve,
                crate::data_privacy::remote_ticket(), mobile.cloned(), None), RequiredAction::Approve, binding,
                Correlation::Approval { ask_id: request_id.into(), provider_request, attempt: uuid::Uuid::new_v4().to_string() });
            self.answer_opencode_carried(&mut rt, request_id, option_id, context)?;
            return Ok(());
        }
        if self.carried_acp(&rt) {
            use provider_authority::{SenderAuthority, RequiredAction, OperationContext, Correlation};
            let binding = self.provider_binding(&rt).context("ACP approval association missing")?;
            // Adapter ask IDs are acp:<numeric provider request> in its native
            // ask registry; the original ID is preserved, never guessed by tag.
            let provider_request = request_id.strip_prefix("acp:").context("ACP ask identity invalid")?.to_string();
            let context = OperationContext::new(SenderAuthority::capture(policy.clone(), RequiredAction::Approve,
                crate::data_privacy::remote_ticket(), mobile.cloned(), None), RequiredAction::Approve, binding,
                Correlation::Approval { ask_id: request_id.into(), provider_request, attempt: uuid::Uuid::new_v4().to_string() });
            let Engine::Acp(a) = &mut rt.engine else { unreachable!() };
            let envelope = a.answer_carried(request_id, option_id, context)?;
            self.stage_acp_actions(&mut rt, vec![envelope]);
            return Ok(());
        }
        let (allow, label) = match &mut rt.engine {
            Engine::Cli(p) => {
                let (decision, label) = match option_id {
                    "deny" => (Decision::Deny, "Denied".to_string()),
                    "allow" => (Decision::Allow, "Allowed".to_string()),
                    crate::harness::read_only::SESSION_OPTION => {
                        let input = crate::harness::read_only::session_input(&ask.tool_name, &ask.input, &session_command)
                            .ok_or_else(|| anyhow!("the command's session allowance has no valid directory scope"))?;
                        (Decision::Execute(input), "Allowed for this session".to_string())
                    }
                    s if s.starts_with("suggest:") => {
                        let i: usize = s[8..].parse().unwrap_or(usize::MAX);
                        let sugg = ask.suggestions.get(i).cloned().ok_or_else(|| anyhow!("unknown option"))?;
                        (Decision::AllowWith(sugg), "Allowed always".to_string())
                    }
                    _ => bail!("unknown option"),
                };
                let allow = !matches!(decision, Decision::Deny);
                let tx = p.decisions.remove(request_id).ok_or_else(|| anyhow!("the agent stopped waiting for that request"))?;
                if let Some(permit) = mobile {
                    tx.queue(QueuedDecision { decision, mobile: Some(MobileDecision {
                        permit: permit.clone(), label, session_command,
                    }) }).map_err(|_| anyhow!("the agent stopped waiting for that request"))?;
                    return Ok(());
                }
                tx.send(decision).map_err(|_| anyhow!("the agent stopped waiting for that request"))?;
                (allow, label)
            }
            Engine::Acp(a) => {
                anyhow::ensure!(mobile.is_none() || a.writing.is_none(), "The agent is still receiving input. Retry the approval shortly.");
                let allow = a.answer_choice(request_id, option_id).ok_or_else(|| anyhow!("that option has no unambiguous outcome"))?;
                let actions = a.answer(request_id, option_id).ok_or_else(|| anyhow!("that request is no longer open"))?;
                self.apply_actions(&mut rt, actions);
                (allow, if allow { "Allowed".to_string() } else { "Denied".to_string() })
            }
            Engine::OpenCode(o) => {
                anyhow::ensure!(!o.answer_pending(request_id), "An answer to this request is still being delivered; try again when it settles");
                let actions = o.answer(request_id, option_id).ok_or_else(|| anyhow!("that request is no longer open"))?;
                self.apply_actions_with_mobile(&mut rt, actions, mobile);
                // The card remains open until the HTTP response confirms delivery.
                return Ok(());
            }
            Engine::CodexStdio(engine) => {
                let actions = engine.answer(request_id, option_id)?;
                self.apply_codex_actions_with_approval(&mut rt, actions, mobile)?;
                // Enqueueing is not delivery. A revoked unsent reply is retryable.
                return Ok(());
            }
            Engine::None => bail!("no engine"),
        };
        // Only remember a grant after the waiting hook accepted its answer.
        if option_id == crate::harness::read_only::SESSION_OPTION {
            self.session_commands.lock().unwrap().entry(key_of(session_id, tab_id)).or_default().insert(session_command);
        }
        rt.pending.remove(request_id);
        self.publish(&mut rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: Some(ask.tool_use_id), allowed: allow, label, automatic: false }, None);
        if rt.pending.is_empty() && !matches!(rt.engine, Engine::Cli(_)) {
            self.set_status(&mut rt, TabStatus::InProgress);
        }
        drop(rt);
        self.observer.answered(session_id, tab_id);
        Ok(())
    }

    fn permission_delivered(&self, rt: &mut TabRuntime, request_id: &str, allow: bool) {
        let Some(ask) = rt.pending.remove(request_id) else { return };
        self.publish(rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: Some(ask.tool_use_id), allowed: allow,
            label: if allow { "Allowed".into() } else { "Denied".into() }, automatic: false }, None);
        if rt.pending.is_empty() { self.set_status(rt, TabStatus::InProgress); }
    }

    /// Answer an AskUserQuestion: the answers ride inside an allow.
    pub fn answer_questions(&self, session_id: &str, tab_id: &str, request_id: &str, answers: HashMap<String, String>) -> Result<()> {
        self.answer_questions_with_mobile(session_id, tab_id, request_id, answers, None)
    }

    pub(crate) fn answer_questions_with_mobile(&self, session_id: &str, tab_id: &str, request_id: &str,
        answers: HashMap<String, String>, mobile: Option<&crate::local_runtime::mobile::WritePermit>) -> Result<()> {
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_approval()?; }
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        let ask = rt.pending.get(request_id).ok_or_else(|| anyhow!("that question is no longer open"))?;
        let tool_use_id = ask.tool_use_id.clone();
        let mut input = ask.input.clone();
        input["answers"] = serde_json::to_value(&answers)?;
        match &mut rt.engine {
            Engine::Cli(p) if p.harness == CliKind::Claude => {
                let tx = p.decisions.remove(request_id).ok_or_else(|| anyhow!("the agent stopped waiting for that question"))?;
                if let Some(permit) = mobile {
                    tx.queue(QueuedDecision { decision: Decision::Answers(input), mobile: Some(MobileDecision {
                        permit: permit.clone(), label: "Answered".into(), session_command: String::new(),
                    }) }).map_err(|_| anyhow!("the agent stopped waiting for that question"))?;
                    return Ok(());
                }
                tx.send(Decision::Answers(input)).map_err(|_| anyhow!("the agent stopped waiting for that question"))?;
            }
            _ => bail!("that agent does not ask questions this way"),
        }
        rt.pending.remove(request_id);
        self.publish(&mut rt, Payload::PermissionDecided { request_id: request_id.into(), tool_use_id: Some(tool_use_id), allowed: true, label: "Answered".into(), automatic: false }, None);
        drop(rt);
        self.observer.answered(session_id, tab_id);
        Ok(())
    }

    /// The app asks for another model. What every view shows as current only
    /// moves when the provider is running it (`harness::settings`): at once
    /// when nothing is running, on the provider's word when something is.
    pub fn set_model(&self, session_id: &str, tab_id: &str, model: &str) -> Result<()> {
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_configuration()?; }
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if policy.as_ref().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2())
            && !matches!(rt.harness.as_str(), "claude" | "codex") {
            bail!("This engine has no collaboration-v2 settings writer");
        }
        if HarnessId::parse(&rt.harness).settings().model == Apply::Restart {
            if let Some(refusal) = Self::by_hand_refusal(&rt, "the model") {
                bail!(refusal);
            }
        }
        let turn_open = rt.turn_open;
        let waits = self.change_waits(&rt, Setting::Model) || self.carried_opencode(&rt);
        let carried = self.carried_acp(&rt) || self.carried_opencode(&rt);
        let original_privacy = crate::data_privacy::remote_ticket();
        let (before, after) = self.update_settings(&mut rt, |s| {
            s.request_model_explicit(model, waits, policy.as_ref(), original_privacy.clone());
            if carried { s.retain_provider_request("model", policy.as_ref(), original_privacy.clone()); }
        })?;
        Self::remember_configuration(&mut rt, &after, "model", policy.as_ref());
        if self.carried_opencode(&rt) {
            let context = self.capture_acp_setting(&mut rt, &after, "model", policy.as_ref())?;
            self.stage_opencode_setting(&mut rt, context);
            return Ok(());
        }
        if self.carried_acp(&rt) {
            let context = self.capture_acp_setting(&mut rt, &after, "model", policy.as_ref())?;
            let Engine::Acp(a) = &mut rt.engine else { unreachable!() };
            let actions = a.set_model_carried(model, after.model_request_id().map(String::from), context)?;
            self.stage_acp_actions(&mut rt, actions);
            return Ok(());
        }
        let mut restart = false;
        match &mut rt.engine {
            // Claude's own `/model` takes the change live, and its status
            // line says when it has. Asking for what is already running while
            // another change is on its way has to be typed too: it is what
            // takes that change back.
            Engine::Cli(p) if p.harness == CliKind::Claude => {
                if after.requested_model.is_some() || before.requested_model.is_some() {
                    p.settings_asked_at = after.waiting().then(Instant::now);
                    self.type_command(p, &rt_arc, format!("/model {model}"));
                }
            }
            // Codex's `/model` opens a picker rather than taking an argument,
            // so its tab is restarted on the same conversation instead: now,
            // or once the turn it would interrupt is over.
            Engine::Cli(p) => {
                if turn_open {
                    p.restart_when_idle = after.requested_permission_mode.is_some() || after.waiting();
                } else {
                    restart = before != after;
                }
            }
            Engine::Acp(a) => {
                let actions = a.set_requested_model(model, after.model_request_id().map(String::from));
                self.apply_actions(&mut rt, actions);
            }
            Engine::OpenCode(o) => o.model = Some(model.into()),
            // Experimental Codex names the model on each turn it starts.
            Engine::CodexStdio(e) => e.set_model(&after.model),
            _ => {}
        }
        drop(rt);
        if restart {
            self.restart_for_settings(session_id, tab_id)?;
        }
        Ok(())
    }

    /// Whether a change asked for now has to wait for the provider: for its
    /// answer, where it takes changes live, or for the turn to end, where it
    /// has to be restarted. With nothing running the change is only what the
    /// next launch is given, and that is already what "current" means.
    fn change_waits(&self, rt: &TabRuntime, setting: Setting) -> bool {
        let how = HarnessId::parse(&rt.harness).settings().of(setting);
        match (&rt.engine, how) {
            (Engine::Cli(_), Apply::Live) => true,
            (Engine::Cli(_), Apply::Restart) => rt.turn_open,
            // The reply to `session/set_model` is its answer.
            (Engine::Acp(_), Apply::Live) => true,
            // OpenCode names the model on each prompt: nothing to wait for.
            _ => false,
        }
    }

    /// Change the tab's model, effort and permission mode through `change`, and tell every
    /// view what moved: a `settings_changed` in the tab's own log when what
    /// is running changed, and the session itself — which the sidebar, the
    /// header, the dashboard and a paired device all draw from — whenever
    /// anything did, a request that is still waiting included.
    /// Bring the tab's mode, and one waiting for the next launch, within
    /// the limit of the bot `entry` works for, if it works for one.
    pub(crate) fn hold_to_bot(&self, rt: &mut TabRuntime, entry: &index::SessionEntry) -> Result<()> {
        let Some(limit) = entry.tab(&rt.tab_id).and_then(|tab| crate::bots::chat::tab_limit(entry, tab)) else { return Ok(()) };
        self.update_settings(rt, |s| {
            s.permission_mode = limit.clamp(&s.permission_mode);
            if let Some(mode) = s.requested_permission_mode.as_mut() {
                *mode = limit.clamp(mode);
            }
        })?;
        Ok(())
    }

    fn update_settings(&self, rt: &mut TabRuntime, mut change: impl FnMut(&mut Settings)) -> Result<(Settings, Settings)> {
        rt.last_settings_report = None;
        // Tried on a copy first: most of what a provider reports changes
        // nothing, and that should not touch the index at all.
        let current = Settings::of(index::get(&rt.session_id)?.tab(&rt.tab_id).ok_or_else(|| anyhow!("tab {} not found", rt.tab_id))?);
        let mut wanted = current.clone();
        change(&mut wanted);
        if wanted == current {
            return Ok((current, wanted));
        }
        // Then made for real on whatever the index holds by now.
        let (current, wanted) = index::update_tab(&rt.session_id, &rt.tab_id, |t| {
            let current = Settings::of(t);
            let mut wanted = current.clone();
            change(&mut wanted);
            wanted.write(t);
            Ok((current, wanted))
        })?;
        let model = (wanted.model != current.model).then(|| wanted.model.clone());
        let effort = (wanted.effort != current.effort).then(|| wanted.effort.clone()).flatten();
        let permission_mode = (wanted.permission_mode != current.permission_mode).then(|| wanted.permission_mode.clone());
        if let (Some(mode), Engine::Cli(p)) = (&permission_mode, &mut rt.engine) {
            // What Codex's every-tool gate goes by: a mode the reader left in
            // the terminal is not asked about on the app's side either.
            p.mode = mode.clone();
        }
        if model.is_some() || wanted.effort != current.effort || permission_mode.is_some() {
            self.publish(rt, Payload::SettingsChanged { model, effort, permission_mode }, None);
        }
        if let Ok(session) = index::get(&rt.session_id) {
            self.sink.emit("session_updated", &session);
        }
        // A cloud runtime's clients list tabs on their own channel.
        self.sink.emit(crate::cloud_agents::TABS_CHANGED, &serde_json::json!({ "tabId": rt.tab_id }));
        Ok((current, wanted))
    }

    /// The provider said something about its own model, effort or permission
    /// stance: the one way a change made on its side — the CLI's `/model`,
    /// its picker, Shift+Tab, a default it resolved at startup — reaches the
    /// tab.
    fn provider_settings(&self, rt: &mut TabRuntime, signal: Signal) {
        // Identical reports from a replacement launch are still fresh
        // witnesses. Deduplicating the settings update must not retain the
        // previous launch's stance identity.
        if let (Signal::Permissions { stance }, Engine::Cli(cli)) = (&signal, &rt.engine) {
            rt.collaboration_stance = Some((cli.tail.clone(), stance.clone()));
        }
        if rt.last_settings_report.as_ref() == Some(&signal) {
            return;
        }
        let agent = agent_name(&rt.harness);
        let result = match &signal {
            Signal::Current { model, effort } => {
                // Only Claude's pickers offer aliases a full id has to be read back into.
                let models = if rt.harness == "claude" { claude::models::known() } else { Vec::new() };
                // What the launch was meant to put the tab on, for whichever
                // settings this word names: each is checked against the
                // first word about it, and once.
                let (asked_model, asked_effort) = match &mut rt.engine {
                    Engine::Cli(p) => {
                        let asked = p.launched_for.as_mut();
                        let asked_model = asked.as_ref().filter(|_| model.is_some()).map(|asked| asked.model.clone()).filter(|asked| !asked.is_empty());
                        let asked_effort = asked.as_ref().filter(|_| effort.is_some()).and_then(|asked| asked.effort.clone());
                        if let Some(asked) = asked {
                            if model.is_some() {
                                asked.model.clear();
                            }
                            if effort.is_some() {
                                asked.effort = None;
                            }
                            if asked.model.is_empty() && asked.effort.is_none() {
                                p.launched_for = None;
                            }
                        }
                        (asked_model, asked_effort)
                    }
                    _ => (None, None),
                };
                self.update_settings(rt, |s| {
                    let model = model.as_deref().map(|reported| settings::canonical_model(s, reported, &models));
                    s.reported(model.as_deref(), effort.as_deref());
                })
                .map(|(_, now)| {
                    // A restart was meant to put the tab on something, and
                    // the first word from the new process says otherwise.
                    let mut misses = Vec::new();
                    if let Some(asked) = asked_model.filter(|asked| *asked != now.model) {
                        misses.push(format!("model {}, not {asked}", now.model));
                    }
                    if let Some(asked) = asked_effort.filter(|asked| Some(asked.as_str()) != now.effort.as_deref()) {
                        misses.push(format!("{} effort, not {asked}", now.effort.as_deref().unwrap_or("default")));
                    }
                    if !misses.is_empty() {
                        self.publish(rt, Payload::Status { text: format!("{agent} is running {}.", misses.join(" and ")), handoff: None }, None);
                    }
                    now
                })
            }
            Signal::Accepted { setting } => self.update_settings(rt, |s| s.accepted(*setting)).map(|(_, now)| now),
            Signal::Refused { setting, value, message } => self.refuse_setting(rt, *setting, value.as_deref(), message),
            Signal::Permissions { stance } => {
                // The last words of a CLI that has been let go of say nothing
                // about the one that replaces it.
                if !matches!(rt.engine, Engine::Cli(_)) {
                    return;
                }
                // A mode a share refuses is held back rather than stored:
                // `judge_reported_mode` says what becomes of it.
                let mut held = None;
                // So may one wider than the bot it works for allows (PRO-468),
                // as when a plan is approved into another mode in the terminal.
                let bot_limit = index::get(&rt.session_id).ok().and_then(|entry| crate::bots::chat::tab_limit(&entry, entry.tab(&rt.tab_id)?));
                let result = self.update_settings(rt, |s| {
                    held = None;
                    let mode = stance.mode(&s.permission_mode);
                    if mode != s.permission_mode && (!settings::allowed_while_shared(&mode) || bot_limit.as_ref().is_some_and(|limit| !limit.allows(&mode))) {
                        held = Some(mode);
                    } else {
                        s.reported_mode(&mode);
                    }
                });
                rt.reported_mode_to_judge = held;
                result.map(|(_, now)| now)
            }
        };
        match result {
            Ok(now) => {
                if let Engine::Cli(p) = &mut rt.engine {
                    if !now.waiting() {
                        p.settings_asked_at = None;
                    }
                }
                rt.last_settings_report = Some(signal);
            }
            Err(error) => log::warn!("settings reported by {}/{}: {error:#}", rt.session_id, rt.tab_id),
        }
    }

    /// A change the provider turned down, or never answered: what the views
    /// call current never moved, so the request is dropped and the reader
    /// told why.
    fn refuse_setting(&self, rt: &mut TabRuntime, setting: Setting, value: Option<&str>, why: &str) -> Result<Settings> {
        let mut dropped = None;
        let (_, now) = self.update_settings(rt, |s| dropped = s.refused(setting, value))?;
        if let Some(value) = dropped {
            let agent = agent_name(&rt.harness);
            let why = why.trim().trim_end_matches('.');
            self.publish(rt, Payload::Status { text: format!("{agent} did not change the {} to {value}: {why}.", setting.noun()), handoff: None }, None);
        }
        Ok(now)
    }

    /// Settle a reported mode `provider_settings` held back. In a session
    /// that is not shared it is simply the mode the tab is in. A shared one
    /// may not be in it, and showing it would not make that so: the CLI is
    /// let go of here, before any guest's prompt can be typed into it, and
    /// started again in the mode the tab was in. Returns whether it was.
    ///
    /// Called with no lock held, after anything that may have heard a report.
    fn judge_reported_mode(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &tui::Tail) -> bool {
        if rt_arc.lock().unwrap().reported_mode_to_judge.is_none() {
            return false;
        }
        let sharing = self.sharing.lock().unwrap();
        let mut rt = rt_arc.lock().unwrap();
        if !Self::has_tail(&rt, tail) { return false; }
        let Some(mode) = rt.reported_mode_to_judge.take() else { return false };
        // A CLI started by hand is not the app's to restart, and takes no
        // guest's prompt (`send_impl`): its mode is simply what it says.
        let by_hand = matches!(&rt.engine, Engine::Cli(p) if p.by_hand.is_some());
        let entry = index::get(&rt.session_id).ok();
        let bot_refusal = entry.as_ref().and_then(|entry| crate::bots::chat::refuses_mode(entry, entry.tab(&rt.tab_id), &mode));
        let shared = sharing.sessions.contains_key(&rt.session_id) && !settings::allowed_while_shared(&mode);
        if by_hand || (!shared && bot_refusal.is_none()) {
            if let Err(error) = self.update_settings(&mut rt, |s| s.reported_mode(&mode)) {
                log::warn!("mode reported by {}/{}: {error:#}", rt.session_id, rt.tab_id);
            }
            return false;
        }
        let agent = agent_name(&rt.harness);
        let kept = entry.as_ref().and_then(|entry| entry.tab(&rt.tab_id).map(|tab| tab.permission_mode.clone())).unwrap_or_default();
        let (reported, kept) = (settings::mode_label(&mode), settings::mode_label(&kept));
        log::warn!("{}/{} reported {mode}, which it may not be in: restarting it in {kept}", rt.session_id, rt.tab_id);
        let text = match &bot_refusal {
            Some(why) if !shared => format!("{agent} was switched to {reported} in the terminal. {why} So {agent} was restarted in {kept}."),
            _ => format!("{agent} was switched to {reported} in the terminal. A shared session cannot be in {reported}, so {agent} was restarted in {kept}. Stop sharing this session before switching to {reported}."),
        };
        self.publish(&mut rt, Payload::Status { text, handoff: None }, None);
        // Whatever it was doing, it was doing in a mode the share forbids.
        self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
        let current_tail = match &rt.engine { Engine::Cli(p) => p.tail.clone(), _ => return false };
        let work = self.prepare_cli_restart(&mut rt, &current_tail, false);
        let (session, tab) = (rt.session_id.clone(), rt.tab_id.clone());
        drop(rt);
        drop(sharing);
        if let Some(work) = work {
            let (manager, rt_arc) = (self.clone(), rt_arc.clone());
            std::thread::spawn(move || {
                if let Err(e) = manager.complete_cli_restart(&rt_arc, work) {
                    log::warn!("restart {session}/{tab}: {e:#}");
                }
            });
        }
        true
    }

    /// Add an agent tab from whichever surface asked. Local sharing retains
    /// the host's chosen modes; cloud v2 checks independent configuration
    /// authority and admits Everyone input separately for each owned launch.
    pub fn add_tab(&self, session_id: &str, tab: &crate::session_ops::NewTab) -> Result<index::TabEntry> {
        self.add_tab_on(session_id, tab, None)
    }

    /// [`Self::add_tab`] on agent account `account` (#980); without one, on
    /// the account its agent's other tabs in the session asked for.
    pub fn add_tab_on(&self, session_id: &str, tab: &crate::session_ops::NewTab, account: Option<&str>) -> Result<index::TabEntry> {
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_configuration()?; }
        let sharing = self.sharing.lock().unwrap();
        if sharing.sessions.contains_key(session_id) && !settings::allowed_while_shared(&index::permission_mode_or_default(tab.permission_mode.as_deref())) {
            bail!("New tabs in a shared session must use a permission mode other than Bypass.");
        }
        let added = crate::session_ops::add_tab_entry_on(session_id, tab, account).map_err(|error| anyhow!(error))?;
        self.first_starts.added(key_of(session_id, &added.id), Instant::now());
        Ok(added)
    }

    /// The app asks for another permission mode. Neither TUI has a command
    /// for one — Claude Code cycles modes on a key, Codex's `/permissions` is
    /// a menu — so the change means replacing the process: now, or once the
    /// turn it would interrupt is over. Until that restart the tab is in the
    /// mode it was in, and is shown in it (`harness::settings`).
    /// Restart a tab's agent on agent account `account` (#980) and resume
    /// its conversation: "Switch account" on a tab, "Continue with …" at a
    /// usage limit. Claude Code's accounts share `projects`, and Codex's
    /// share `sessions`, so the conversation is found on the new one. A tab
    /// whose agent is not running only records the account, which its next
    /// start uses. Refused while a turn runs: it would be cut off.
    ///
    /// `true` when a running agent was restarted (or, native Codex, stopped
    /// to resume on its next prompt); `false` when only the account was
    /// recorded.
    pub fn switch_account(&self, session_id: &str, tab_id: &str, account: &str) -> Result<bool> {
        let restarted = self.switch_account_on(session_id, tab_id, account)?;
        // The person's own move: automatic switching leaves it there until
        // that account is full (#981).
        self.account_moved_by_hand(session_id, tab_id, account);
        Ok(restarted)
    }

    /// [`Self::switch_account`]'s restart and resume, which automatic
    /// switching (#981) makes too.
    fn switch_account_on(&self, session_id: &str, tab_id: &str, account: &str) -> Result<bool> {
        let account = crate::session_ops::requested_account(Some(account)).map_err(|error| anyhow!(error))?.context("Choose an account to switch to.")?;
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab {tab_id} not found"))?;
        let agent = crate::agent_keys::Agent::of(&tab.harness).ok_or_else(|| anyhow!("This agent has no accounts to switch between."))?;
        let accounts = crate::agent_keys::store()?.entry(agent)?;
        anyhow::ensure!(crate::agent_accounts::exists(&accounts, &account), "{}", crate::platform_profile::localize(&format!("That account is not one of {}'s on this Mac.", agent.label())));
        if let Some(rt_arc) = self.tabs.lock().unwrap().get(&key_of(session_id, tab_id)).cloned() {
            let rt = rt_arc.lock().unwrap();
            if let Some(refusal) = Self::by_hand_refusal(&rt, "its account") { bail!(refusal); }
            anyhow::ensure!(!rt.turn_open, "Wait for the turn to end, or stop it, before switching accounts.");
        }
        self.mobile.invalidate_tab(session_id, tab_id);
        index::update_tab(session_id, tab_id, |t| {
            crate::session_ops::set_tab_account(t, Some(&account));
            Ok(())
        })?;
        if !self.is_running(session_id, tab_id) {
            return Ok(false);
        }
        let cli = matches!(&self.runtime(session_id, tab_id)?.lock().unwrap().engine, Engine::Cli(_));
        if cli {
            // In the same pane, resuming the conversation, as a settings
            // restart does: the new launch reads the account from the tab.
            self.restart_for_settings(session_id, tab_id)?;
        } else {
            // Native Codex resumes its thread with the next prompt it is sent.
            self.stop(session_id, tab_id)?;
        }
        Ok(true)
    }

    pub fn set_permission_mode(&self, session_id: &str, tab_id: &str, mode: &str) -> Result<()> {
        // No mode wider than a bot's access, from the picker, the CLI or a phone (PRO-468).
        let entry = index::get(session_id)?;
        if let Some(refusal) = crate::bots::chat::refuses_mode(&entry, entry.tab(tab_id), mode) {
            bail!(refusal);
        }
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_configuration()?; }
        self.mobile.invalidate_tab(session_id, tab_id);
        let sharing = self.sharing.lock().unwrap();
        if sharing.sessions.contains_key(session_id) && !settings::allowed_while_shared(mode) {
            bail!("Stop sharing this session before switching to {}.", settings::mode_label(mode));
        }
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if policy.as_ref().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2())
            && !matches!(rt.harness.as_str(), "claude" | "codex") {
            bail!("This engine has no collaboration-v2 settings writer");
        }
        if let Some(refusal) = Self::by_hand_refusal(&rt, "the permission mode") {
            bail!(refusal);
        }
        let turn_open = rt.turn_open;
        let stdio = self.codex_stdio_mode_change(session_id, tab_id, mode, turn_open)?;
        let waits = self.carried_opencode(&rt) || (turn_open && matches!(rt.engine, Engine::Cli(_))) || matches!(&rt.engine, Engine::Acp(a) if !a.ready || a.writing.is_some());
        let carried = self.carried_acp(&rt) || self.carried_opencode(&rt);
        let original_privacy = crate::data_privacy::remote_ticket();
        let (before, after) = self.update_settings(&mut rt, |s| {
            s.request_mode_explicit(mode, waits, policy.as_ref(), original_privacy.clone());
            if carried { s.retain_provider_request("mode", policy.as_ref(), original_privacy.clone()); }
        })?;
        Self::remember_configuration(&mut rt, &after, "mode", policy.as_ref());
        // A mode set now is the tab's own: a bot's resume no longer gives it an earlier one (PRO-468).
        if entry.tab(tab_id).is_some_and(|tab| tab.unknown.contains_key(crate::bots::chat::HELD_FROM_KEY)) {
            if let Err(error) = index::update_tab(session_id, tab_id, |tab| {
                tab.unknown.remove(crate::bots::chat::HELD_FROM_KEY);
                Ok(())
            }) {
                log::warn!("forget the mode {session_id}/{tab_id} had before its bot's limit: {error:#}");
            }
        }
        if self.carried_opencode(&rt) {
            let context = self.capture_acp_setting(&mut rt, &after, "mode", policy.as_ref())?;
            self.stage_opencode_setting(&mut rt, context);
            return Ok(());
        }
        if self.carried_acp(&rt) {
            let context = self.capture_acp_setting(&mut rt, &after, "mode", policy.as_ref())?;
            let Engine::Acp(a) = &mut rt.engine else { unreachable!() };
            let actions = a.set_mode_carried(mode, context)?;
            self.stage_acp_actions(&mut rt, actions);
            return Ok(());
        }
        let mut restart = false;
        match &mut rt.engine {
            Engine::Cli(p) => {
                if turn_open {
                    // Asking for the mode it is in takes a waiting change
                    // back, and with it the restart, unless Codex still has
                    // a model or effort waiting on one.
                    let codex_waits = p.harness == CliKind::Codex && (after.requested_model.is_some() || after.requested_effort.is_some());
                    p.restart_when_idle = after.requested_permission_mode.is_some() || codex_waits;
                } else {
                    // Even for the mode the tab is shown in: the reader may
                    // have left it in the terminal since the CLI last said.
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
        let stop_stdio = stdio && before.permission_mode != after.permission_mode && matches!(rt.engine, Engine::CodexStdio(_));
        drop(rt);
        if restart {
            self.restart_for_settings(session_id, tab_id)?;
        }
        if stop_stdio {
            self.stop_codex_stdio(&rt_arc, false)?;
        }
        drop(sharing);
        Ok(())
    }

    /// Claude takes effort live through its own `/effort`. Codex has no such
    /// command, so its tab is restarted on the same conversation; the
    /// headless peers have no effort setting at all, and say so rather than
    /// take a value that would change nothing.
    pub fn set_effort(&self, session_id: &str, tab_id: &str, effort: Option<&str>) -> Result<()> {
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_configuration()?; }
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if policy.as_ref().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2())
            && !matches!(rt.harness.as_str(), "claude" | "codex") {
            bail!("This engine has no collaboration-v2 settings writer");
        }
        if HarnessId::parse(&rt.harness).settings().effort == Apply::Unsupported && effort.is_some_and(|e| !e.is_empty()) {
            bail!("{} has no effort setting.", agent_name(&rt.harness));
        }
        if HarnessId::parse(&rt.harness).settings().effort == Apply::Restart {
            if let Some(refusal) = Self::by_hand_refusal(&rt, "the effort") {
                bail!(refusal);
            }
        }
        let turn_open = rt.turn_open;
        let waits = self.change_waits(&rt, Setting::Effort)
            && (HarnessId::parse(&rt.harness).settings().effort == Apply::Restart || effort.is_some_and(|e| !e.is_empty()));
        let (before, after) = self.update_settings(&mut rt, |s| s.request_effort(effort, waits))?;
        Self::remember_configuration(&mut rt, &after, "effort", policy.as_ref());
        let mut respawn = false;
        let mut restart = false;
        match &mut rt.engine {
            Engine::Cli(p) if p.harness == CliKind::Claude => {
                if let Some(e) = effort.filter(|e| !e.is_empty()) {
                    if after.requested_effort.is_some() || before.requested_effort.is_some() {
                        p.settings_asked_at = after.waiting().then(Instant::now);
                        self.type_command(p, &rt_arc, format!("/effort {e}"));
                    }
                }
            }
            Engine::Cli(p) => {
                if turn_open {
                    p.restart_when_idle = after.requested_permission_mode.is_some() || after.waiting();
                } else {
                    restart = before != after;
                }
            }
            Engine::Acp(_) | Engine::OpenCode(_) => {}
            Engine::CodexStdio(e) => e.set_effort(after.effort.as_deref()),
            _ => respawn = !turn_open,
        }
        if respawn {
            self.host.kill(&rt.key());
            crate::cloud_grants::forget_launch(&rt.key());
            rt.child = None;
            rt.child_pid = None;
            self.note_child(&rt);
            rt.engine = Engine::None;
            self.retire_provider(&rt);
        }
        drop(rt);
        if restart {
            self.restart_for_settings(session_id, tab_id)?;
        }
        Ok(())
    }

    pub fn mark_read(&self, session_id: &str, tab_id: &str) -> Result<()> {
        self.set_tab_unread(session_id, tab_id, false)
    }

    pub fn set_tab_unread(&self, session_id: &str, tab_id: &str, unread: bool) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        // Save before publishing; a failed write must not acknowledge the reminder.
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab {tab_id} not found"))?;
        if tab.marked_unread == unread && (unread || tab.status != TabStatus::Completed) { return Ok(()); }
        index::set_tab_unread(session_id, tab_id, unread)?;
        if !unread && rt.status == TabStatus::Completed {
            // A read is not agent activity and must not reorder the dashboard.
            self.announce_display_status(&mut rt, TabStatus::Idle);
        }
        self.sink.emit("session_updated", &index::get(session_id)?);
        Ok(())
    }

    pub fn kill_all(&self) {
        self.closing();
        if let Err(error) = store::activity::shutdown() {
            log::error!("flush activity on shutdown: {error:#}");
        }
        self.host.kill_all();
    }

    pub(crate) fn accepting_work(&self) -> Result<()> {
        if self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            bail!("The local runtime is stopping; no new work was accepted.");
        }
        Ok(())
    }

    /// Fence follow-ups before terminating processes. A late completion must
    /// not drain a queue or start a replacement during stop-all/logout.
    /// Stop-all acknowledgement means the owned process groups actually exited.
    /// Preserve failed PIDs in tab state so an explicit retry can confirm them.
    pub(crate) fn stop_all_confirmed(&self) -> Result<()> {
        let _admission = crate::issue_pipeline::admission::lock();
        self.begin_shutdown();
        let tabs: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        let mut pids = self.terminals.census_groups();
        for tab in &tabs {
            let tab = tab.lock().unwrap();
            pids.extend(tab.child_pid.or(tab.stopping_pid));
        }
        pids.extend(self.stop_pids.lock().unwrap().iter().copied());
        pids.extend(self.session_stop_pids.lock().unwrap().values().flatten().copied());
        pids.sort_unstable();
        pids.dedup();
        let mut failures = Vec::new();
        for tab in tabs {
            let (session, id) = { let tab = tab.lock().unwrap(); (tab.session_id.clone(), tab.tab_id.clone()) };
            if let Err(error) = self.stop(&session, &id) { failures.push(error.to_string()); }
        }
        let panes: Vec<_> = self.terminals.panes().into_iter().map(|pane| pane.id).collect();
        let terminal_stops = self.terminals.begin_stop_all(&panes);
        let terminals_confirmed = pty::StoppingPane::wait_all(&terminal_stops, RESTART_WAIT);
        self.terminals.stop_owned_groups(RESTART_WAIT);
        // The existing second bounded phase can confirm a batch whose first
        // wait expired. Recheck those exact handles, not only original PIDs.
        if let Err(error) = Self::settle_pty_wait(&terminal_stops, terminals_confirmed) {
            failures.push(error.to_string());
        }
        self.host.kill_all_and_wait(RESTART_WAIT);
        pids.retain(|pid| crate::harness::host::group_or_process_alive(*pid));
        *self.stop_pids.lock().unwrap() = pids.clone();
        if !pids.is_empty() || !self.terminals.owned_groups().is_empty() {
            bail!("Stop all could not confirm every process exited. Retry Stop all; the runtime remains stopping.");
        }
        if !failures.is_empty() { bail!("Stop all could not settle every tab: {}", failures.join("; ")); }
        Ok(())
    }

    fn settle_pty_wait(panes: &[pty::StoppingPane], initially_confirmed: bool) -> Result<()> {
        if !initially_confirmed && panes.iter().any(|pane| pane.pid().is_some()) {
            bail!("PTY process exit could not be confirmed. Retained ownership must be stopped before retrying the operation.");
        }
        Ok(())
    }

    pub(crate) fn begin_shutdown(&self) {
        self.shutting_down.store(true, std::sync::atomic::Ordering::SeqCst);
        self.closing();
        let runtimes: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        for runtime in runtimes {
            let mut runtime = runtime.lock().unwrap();
            runtime.stopping = true;
            runtime.restart_claim = None;
            if matches!(runtime.engine, Engine::CodexStdio(_)) { self.withdraw_codex_followups(&mut runtime); }
            runtime.queued.clear();
            self.with_provider_state(&runtime, |state| state.queue.clear());
            if let Engine::Cli(cli) = &mut runtime.engine {
                for echo in &mut cli.echoed {
                    if let Some(receipt) = echo.receipt.take() {
                        let _ = receipt.send(Err("The local runtime was stopped before prompt delivery was confirmed.".into()));
                    }
                }
            }
            self.cancel_asks(&mut runtime);
        }
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
        let policy = collaboration_v2::current();
        let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission());
        if let Some(permit) = &policy { permit.check_configuration()?; }
        let _admission = crate::issue_pipeline::admission::lock_for(session_id, tab_id);
        self.accepting_work()?;
        // Nothing starts in a session that is being deleted or moved, or in a
        // workspace that is being removed.
        crate::issue_pipeline::admission::open(session_id, Some(tab_id))?;
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut entry = index::get(session_id)?;
        let mut tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        // A tab that is a terminal is opened as one: its shell, and no agent.
        // So is one whose hand-started agent is no longer being followed.
        let following = matches!(&rt_arc.lock().unwrap().engine, Engine::Cli(p) if p.by_hand.is_some());
        if tab.is_terminal() || (tab.by_hand() && !following) {
            return self.shell_for(session_id, tab_id);
        }
        // Started like any Codex tab when native Codex cannot serve it.
        if self.codex_stdio_falls_back(&rt_arc.lock().unwrap(), &tab)? {
            entry = index::get(session_id)?;
            tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        }
        if codex_stdio::selected(&tab) || pty_first(&tab.harness).is_none() {
            return Ok(());
        }
        let mut rt = rt_arc.lock().unwrap();
        match self.start_cli(&mut rt, &rt_arc, &entry, &tab, false) {
            Ok(false) => self.announce_pane(&rt),
            Ok(true) => {},
            Err(error) => {
                // Why the agent could not start (Codex too old, not installed)
                // is TerminalX's own word: its line is shown under the error (#667).
                let message = format!("{error:#}");
                self.apply(&mut rt, Payload::Error { detail: recovery::detail(&message), message, fatal: false }, None);
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
        Self::pane_event(&rt).or_else(|| {
            // A tab that is a terminal has a pane and no CLI in it.
            let entry = index::get(session_id).ok()?;
            let tab = entry.tab(tab_id).filter(|tab| tab.is_terminal() && self.terminals.is_live(&tab.pane_id()))?;
            Some(Self::terminal_pane_event(session_id, tab))
        })
    }

    /// The process in a PTY pane exited. Hooks normally close the turn
    /// first; when they do not, what becomes of the tab is `cli_gone`'s to say.
    pub fn pane_exited(&self, pane_id: &str, code: Option<i32>) {
        // First: a CLI whose sign-in was refused reports the grant it was
        // launched with, which is forgotten just below (#667).
        if let Some((entry, tab)) = self.tab_of_pane(pane_id) {
            if let Ok(rt_arc) = self.runtime(&entry.id, &tab.id) {
                self.cli_gone(&rt_arc, pane_id, code, TurnStatus::Error);
            }
        }
        // A delayed exit from a replaced pane must not forget what its
        // successor was launched with (its grant, its configuration and MCP
        // file).
        if !self.terminals.is_running(pane_id) {
            crate::cloud_grants::forget_launch(pane_id);
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
            by_hand: p.by_hand.is_some(),
            terminal: false,
        })
    }

    fn announce_pane(&self, rt: &TabRuntime) {
        if let Some(ev) = Self::pane_event(rt) {
            self.sink.emit("tab_pty", &ev);
        }
    }

    /// Startup holds the runtime lock. Never wait for a previous launch here:
    /// close admission and retain its exact handles for the explicit Stop path,
    /// which releases the runtime before waiting.
    fn require_prior_cli_exit(&self, _rt: &mut TabRuntime, pane: &str) -> Result<()> {
        // An earlier launch of this pane that is still on its way out (its
        // CLI exited into a #437 shell, which let go of it with a terminate
        // that takes up to two seconds) is waited for, bounded, as main
        // waits for the pane itself. One that still has not gone refuses
        // only this start: the tab is not left stopping, the next prompt
        // checks again, and Stop still finds it by its pane id.
        let pending = self.terminals.detached_stops(pane);
        if !pending.is_empty() && !pty::StoppingPane::wait_all(&pending, RESTART_WAIT) {
            bail!("The agent's previous process has not exited yet. Send the prompt again in a moment, or press Stop.");
        }
        Ok(())
    }

    /// Returns whether this call is what started it, so a prompt sent in the
    /// same breath knows to wait for the TUI to finish drawing. `prompting`
    /// is whether the caller is about to send one.
    fn start_cli(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry, tab: &TabEntry, prompting: bool) -> Result<bool> {
        let permits = Self::pending_configuration_permits(rt)?;
        // Runtime is already held: use try admission to avoid reversing the
        // policy -> runtime order against a refresh or a direct operation.
        let _policy: Vec<_> = permits.iter().map(|permit| permit.collaboration.try_enter_admission()
            .context("Collaboration policy is changing; retry the launch")).collect::<Result<_>>()?;
        if let Some(permit) = collaboration_v2::current() { Self::check_collaboration_permit(&permit, rt)?; }
        let result = self.start_cli_inner(rt, rt_arc, entry, tab, prompting);
        if !rt.stopping && rt.restart_claim.is_none() { rt.setup_failed = result.is_err(); }
        result
    }

    fn start_cli_inner(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry, tab: &TabEntry, prompting: bool) -> Result<bool> {
        self.accepting_work()?;
        if rt.stopping { bail!("Stop has not confirmed local process exit. Retry Stop before resuming."); }
        if rt.restart_claim.is_some() { bail!("The agent is restarting to apply its settings. Try again shortly."); }
        anyhow::ensure!(!codex_stdio::selected(tab), "Experimental stdio sessions cannot launch a PTY owner");
        let Some(kind) = pty_first(&tab.harness) else { return Ok(false) };
        let pane = tab.pane_id();
        if let Engine::Cli(p) = &rt.engine {
            if p.pane_id == pane && self.terminals.is_running(&pane) {
                return Ok(false);
            }
        }
        let _privacy = self.admit_pending_settings(rt)?;
        // In use again: a stop for idleness is over.
        if tab.parked {
            if let Err(error) = index::set_parked(&rt.session_id, &rt.tab_id, false) {
                log::warn!("mark {}:{} as in use again: {error:#}", rt.session_id, rt.tab_id);
            }
        }
        // An orderly idle exit left history, not a process to kill. Keep
        // those bytes for the newly resumed CLI's terminal stream.
        self.require_prior_cli_exit(rt, &pane)?;
        // What the tab's terminal runs now (a shell its last CLI left, #437)
        // is stopped as before; one whose exit is not confirmed stays owned,
        // for the check above to refuse the next start.
        if self.terminals.is_live(&pane) {
            self.terminals.kill_and_wait_confirmed(&pane, RESTART_WAIT)?;
        }
        // A conversation the reader started by hand comes with no mode the
        // app knows (#437). Launched by the app it runs in the one that asks:
        // not the app's default, which would hand it more than the reader
        // may have, and from here on a mode the picker shows and can change.
        if tab.permission_mode == follow::MODE_SET_IN_TERMINAL {
            self.update_settings(rt, |s| s.permission_mode = follow::MODE_WHEN_RESUMED.into())?;
        }
        // A session that works for a bot launches in no wider a mode than
        // the bot's access allows now, whatever the tab was left in (PRO-468).
        self.hold_to_bot(rt, entry)?;
        let tab = &index::get(&rt.session_id)?.tab(&rt.tab_id).cloned().unwrap_or_else(|| tab.clone());
        // A model, effort or mode that was waiting for the process to be
        // replaced rides with this launch, and is what the tab runs from
        // here on.
        let waited = Settings::of(tab);
        let mut launching = waited.clone();
        launching.launched();
        // A mode that waited is not part of that check: the CLI names its
        // mode with its first prompt, and that is simply shown.
        let launched_for = (launching.model != waited.model || launching.effort != waited.effort).then(|| launching.clone());
        let tab = &{
            let mut tab = tab.clone();
            launching.write(&mut tab);
            tab
        };
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
        // A run's worker never pushes (`orchestration::guard`): every git its
        // agent starts, in a script as much as on a command line, reads a
        // configuration that sends a push nowhere. Without it the worker
        // does not start.
        if crate::orchestration::guard::limited(entry) {
            let config = crate::orchestration::guard::git_config(&entry.id, Path::new(&entry.cwd)).context("write the run worker's git configuration")?;
            env.push(("GIT_CONFIG_GLOBAL".to_string(), config.to_string_lossy().into_owned()));
        }
        // A fresh secret per launch, per tab: the socket path is inherited by
        // every process the agent starts, so what keeps one tab's hooks from
        // speaking for another is that only this CLI was given this token.
        let token = crate::hooks::mint_token();
        // This launch's own socket, not the home's published one: another
        // TerminalX on the same home may hold that, and it does not know
        // this tab (#202).
        env.push((crate::hooks::SOCKET_ENV.to_string(), self.control.socket.to_string_lossy().into_owned()));
        env.push((crate::hooks::TOKEN_ENV.to_string(), token.clone()));
        // A cloud workspace's agent credentials (`cloud_grants`), from one
        // snapshot: the variables, the creator's own route for this agent
        // (PRO-18: its model, what its CLI takes on the command line) and
        // Codex's auth file. The tab is told what keeps a route from working.
        // On a Mac, the API key saved for the agent in Settings, if it uses
        // one (`agent_keys`, PRO-306): a tab set to use a key this runtime
        // does not have is not started on another login.
        // On the agent account the tab asked for, or its project's default,
        // or its agent's (#980): an added subscription's directory is the
        // agent's CLAUDE_CONFIG_DIR or CODEX_HOME. With This Mac's login
        // alone the grant is the one above, word for word.
        let asked = crate::session_ops::tab_account(tab).map(str::to_owned);
        // Another account when automatic switching finds this one full (#981).
        let (asked, moved) = self.launch_account(&rt.session_id, &rt.tab_id, &tab.harness, crate::session_ops::project_key(entry), &entry.title, asked);
        if let Some(text) = moved {
            self.publish(rt, Payload::Status { text, handoff: None }, None);
        }
        let grant = crate::agent_keys::launch_grant_on(&tab.harness, Path::new(&entry.cwd), crate::agent_keys::Choice { account: asked.as_deref(), project: crate::session_ops::project_key(entry) })?;
        if let Some(text) = grant.route.as_ref().and_then(|route| route.notice.clone()) {
            self.publish(rt, Payload::Status { text, handoff: None }, None);
        }
        let on = AccountLaunch::of(kind, &grant);
        let launch = match kind {
            CliKind::Claude => self.claude_launch(rt, entry, tab, &exe, grant.route.as_ref(), &on)?,
            CliKind::Codex => self.codex_launch(rt, entry, tab, &exe, &mut env, &grant, &on)?,
        };
        // The reader has been told about a substitution already.
        let launched_for = launched_for.map(|asked| Settings { model: launch.model.clone().unwrap_or(asked.model), ..asked });

        // A cloud workspace's configuration (`cloud_config`): variables,
        // bound secrets, prompts and MCP servers. Before the grants, so an
        // agent credential always wins.
        let config = crate::cloud_config::launch_config(&tab.harness, &pane);
        #[cfg(unix)]
        let guest = crate::local_vm::guest::launch_config(&rt.session_id, &rt.tab_id, &tab.harness)?;
        #[cfg(not(unix))]
        let guest = crate::cloud_config::LaunchConfig::default();
        // Its desktop tools (`computer_targets.rs`): a guest worker's own
        // binding, else the computer the tab chose, else the Local VM while
        // the reader has it on (`container_vm.rs`).
        let (guest_env, computer) = computer_launch(guest, || crate::computer_targets::launch_args(&rt.session_id, tab))?;
        env.extend(config.env);
        env.extend(guest_env);
        // The agent credentials read above; names to unset are dropped after
        // the login shell's profile has run.
        crate::cloud_grants::record_launch(&pane, &grant);
        on.record(&pane, &tab.harness, &rt.session_id, &rt.tab_id, asked.is_some());
        // Set again after the login shell's profile, which could export its
        // own: an added account's directory (`cloud_grants::env_prefix`).
        let after_profile = grant.after_profile.clone();
        let mut unset = Vec::new();
        for (name, value) in grant.env {
            match value {
                Some(value) => env.push((name, value)),
                None => unset.push(name),
            }
        }
        // One appended prompt for everything the agent is told: the
        // workspace's prompts, the Local VM's note, which folders a sparse
        // checkout has (`sparse_checkout.rs`), and a bot's role and memory
        // (`bots::chat`). A second `--append-system-prompt` or
        // `developer_instructions` would replace the first.
        // The text itself travels in a variable the shell expands as one
        // word, never on its command line, and the agent is not left with it.
        crate::bots::chat::look_before_launch(self.sink().as_ref(), entry);
        let prompt = cli_prompt(entry, tab, config.prompt.as_deref(), computer.note)?;
        if let Some(value) = prompt.value {
            env.push((crate::cloud_config::APPENDED_PROMPT_ENV.to_string(), value));
            unset.push(crate::cloud_config::APPENDED_PROMPT_ENV.to_string());
        }
        // The cloud desktop's browser, only while the workspace offers it (PRO-209).
        let browser = crate::cloud_browser::launch_args(&tab.harness, &exe.to_string_lossy());
        let spawned = crate::cloud_grants::env_prefix(&format!("{}{}{}{}{}", launch.command, config.args, computer.args, browser, prompt.args), &unset, &after_profile);
        let usage_account = (kind == CliKind::Claude).then(crate::status::usage::claude_account_identity).flatten();
        let tail = Arc::new(launch.tail);
        // Kept up with the file this tab's tail follows, wherever it moves,
        // from where it stands now: what a CLI before this one left running
        // went with it.
        rt.background = (kind == CliKind::Claude).then(|| Arc::new(Mutex::new(claude::background::Watch::new(tail.clone()))));
        env.retain(|(key, _)| !matches!(key.as_str(), "TERMINALX_PORT" | "TERMINALX_PORTS"));
        env.extend(index::workspace_ports::environment(&entry.cwd)?);
        // No login shell runs first on Windows to `env -u` these: the pane leaves them out itself.
        #[cfg(windows)]
        for name in &unset {
            if !env.iter().any(|(key, _)| key.eq_ignore_ascii_case(name)) {
                env.push((name.clone(), pty::REMOVE_FROM_ENV.to_string()));
            }
        }
        let spec = pty::PaneSpec { cwd: &entry.cwd, cols: CLI_PANE_SIZE.0, rows: CLI_PANE_SIZE.1, command: Some(&spawned), env: &env };
        #[cfg(test)]
        let refused = crate::bots::items::FAIL_LAUNCHES_FOR_TESTS.load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        let refused = false;
        let started = if refused { Err(anyhow!("the agent's CLI could not start (a test refused it)")) } else { self.terminals.spawn(self.sink.clone(), &pane, spec).context("start the agent's CLI").map(|_| ()) };
        // The agent is running, or never will: in a bot's home chat that started, the owner's waiting messages are
        // sent now as messages (`bots::chat::launched`); after a failed launch they keep waiting.
        crate::bots::chat::launched(self, entry, &tab.id, started.is_ok());
        started?;
        let generation = self.starts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        rt.engine = Engine::Cli(CliTab {
            usage_account,
            harness: kind,
            mode: tab.permission_mode.clone(),
            pane_id: pane.clone(),
            generation,
            launched_at: Instant::now(),
            restart_when_idle: false,
            settings_asked_at: None,
            launched_for,
            status_names_model: false,
            settings_command_is_ours: false,
            // Claude Code runs its SessionStart hook the moment it is up;
            // Codex has no session, and so no hook, until a prompt makes one.
            ready: Arc::new(tui::Ready::new(kind == CliKind::Claude)),
            recorded: false,
            tail: tail.clone(),
            echoed: Default::default(),
            lapsed: Default::default(),
            awaiting_delivery: None,
            delivery_sent_at: None,
            accept_by: None,
            nudge_by: None,
            nudges_left: 0,
            entered_at: None,
            held: Vec::new(),
            prompts: RecordedPrompts::default(),
            input: InputBox::default(),
            resend_after_abort: None,
            codex_interrupt_hooks_owed: 0,
            codex_prompt_starts_turn: false,
            decisions: HashMap::new(),
            turn_tail: Default::default(),
            transcript_turn: None,
            transcript_end_owed: false,
            command: launch.command,
            origin: Origin { token, transcript_root: launch.transcript_root, conversation: launch.conversation },
            by_hand: None,
        });
        rt.turn_open = false;
        self.announce_pane(rt);
        self.follow_transcript(rt_arc, tail, pane, generation);
        // The process is now fully owned, including its hook token and
        // transcript follower. No fallible persistence may leave a live CLI
        // unregistered. An uncommitted request keeps its original ticket.
        // Persistence failure requires Stop before retrying; the normal
        // Stop path still owns this process.
        let committed = (|| -> Result<()> {
            if launching != waited { self.update_settings(rt, |s| s.launched())?; }
            if let Some(account) = &on.id {
                index::update_tab(&rt.session_id, &rt.tab_id, |t| {
                    crate::session_ops::set_launched_account(t, account);
                    Ok(())
                })?;
            }
            if let Some(id) = launch.minted {
                index::update_tab(&rt.session_id, &rt.tab_id, |t| {
                    t.provider_session_id = Some(id.clone());
                    // Keep fork_from until the new CLI has its own transcript.
                    Ok(())
                })?;
            }
            Ok(())
        })();
        if let Err(error) = committed {
            rt.stopping = true;
            self.needs_recovery(rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
            return Err(error.context("The agent started, but its launch settings could not be saved. Stop the agent before retrying"));
        }
        if let Some(restart) = launch.restart {
            self.restarted(rt, rt_arc, restart, prompting);
        }
        Ok(true)
    }

    /// Claude Code: the app mints the conversation id, so the transcript's
    /// path is known before the CLI has written a byte.
    ///
    /// The CLI writes that file only once it takes a prompt. `--resume` of a
    /// conversation with no file is refused ("No conversation found") and
    /// the CLI exits on the spot, so one that never started — or whose file
    /// has gone — is started again under the same id (#663).
    fn claude_launch(&self, rt: &TabRuntime, entry: &index::SessionEntry, tab: &TabEntry, exe: &Path, route: Option<&crate::cloud_grants::RouteLaunch>, on: &AccountLaunch) -> Result<CliLaunch> {
        // An added account's `projects` is a link to the person's own, so a
        // conversation resumes on whichever account the tab runs on; it is
        // followed from where this CLI writes.
        let projects = crate::agent_data::claude_projects_root_in(on.home.as_deref()).ok_or_else(|| anyhow!("no home directory"))?;
        let provider_id = tab.provider_session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // Where the conversation's file is, not where a conversation started
        // in this folder would be: a resumed one is still written where it
        // began, which a renamed workspace no longer derives (#250).
        let path = claude::transcript::locate_in(&projects, &entry.cwd, &provider_id);
        let resume = tab.provider_session_id.is_some() && path.is_file();
        // A fork is made from its parent until it has a file of its own, and
        // only while the parent has one to make it from.
        let fork_from = if resume { None } else { tab.fork_from.clone().filter(|parent| claude::transcript::locate_in(&projects, &entry.cwd, parent).is_file()) };
        let restart = match (&tab.provider_session_id, &tab.fork_from) {
            _ if resume => None,
            // Never launched, so nothing was sent to it. A fork loses only
            // the parent it was to be made from.
            (None, Some(_)) if fork_from.is_none() => Some(unsent::Restart::Lost),
            (None, _) => None,
            // What its agent answered is gone with the file, unless the
            // parent it is made from again still has it.
            (Some(_), _) => unsent::restart(unsent::said_in(&rt.log_path, tab.follow.conversation.as_deref()), tab.continuation, fork_from.is_none()),
        };
        let mut settings = claude::pty::settings_json(exe);
        // A user-managed route's credential helper, for this session only:
        // `--settings` sits above the user's and the checkout's files.
        if let Some(helper) = route.and_then(|route| route.api_key_helper.clone()) {
            settings["apiKeyHelper"] = serde_json::Value::String(helper);
        }
        // A route's endpoint, at the level above the checkout's own settings.
        if let Some(env) = route.map(|route| &route.claude_settings_env).filter(|env| !env.is_empty()) {
            settings["env"] = env.iter().map(|(name, value)| (name.clone(), serde_json::Value::String(value.clone()))).collect::<serde_json::Map<_, _>>().into();
        }
        // A run's worker is handed its limits at launch (`orchestration::guard`):
        // deny rules hold in every permission mode, bypass included.
        if crate::orchestration::guard::limited(entry) {
            crate::orchestration::guard::claude_settings(&mut settings);
        }
        // A session acting for a bot runs no skill's inline command, which no hook would see (PRO-494).
        crate::bots::access::claude_settings(rt.acting_bot.as_deref(), &mut settings);
        // A route that names its model runs on it: the endpoint may serve no
        // model of the tab's name.
        let route_model = route.and_then(|route| route.model.clone());
        let command = claude::pty::launch_command(claude::pty::LaunchOptions {
            provider_session_id: &provider_id,
            resume,
            fork_from: fork_from.as_deref(),
            model: route_model.as_deref().unwrap_or(&tab.model),
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
        // In the account's own `.claude.json` when the tab runs on one.
        let trusted = match on.home.as_deref() {
            Some(dir) => claude::trust::prepare_in(dir, &entry.cwd),
            None => claude::trust::prepare(&entry.cwd),
        };
        if let Err(e) = trusted {
            log::warn!("prepare the Claude Code config for {}: {e:#}", entry.cwd);
        }
        let derived = claude::transcript::transcript_in(&projects, &entry.cwd, &provider_id);
        // The folder derived from the checkout is where the CLI files what
        // it starts here, and a file it reports has to be in it — or be this
        // conversation's own, in the folder it was found in. Both stay
        // allowed: which of the two a `/clear` opens its new file in is the
        // CLI's business.
        let transcript_root = derived.parent().context("the transcript path has no directory")?.to_path_buf();
        let mut conversation = crate::hooks::ConversationFile::new(projects.clone(), format!("{provider_id}.jsonl"));
        if path != derived {
            conversation.adopt(&path);
        }
        // A fork is handed a copy of the whole parent conversation, written
        // into its new file when the first turn lands. The app already has all
        // of it, and the copy keeps each record's original uuid, so those are
        // the ones to drop.
        let carried = fork_from.as_deref().and_then(|parent| claude::transcript::record_uuids_in(&projects, &entry.cwd, parent)).unwrap_or_default();
        Ok(CliLaunch {
            command,
            model: route_model.filter(|model| *model != tab.model),
            tail: tui::Tail::opening(path, claude::transcript::decode_line, carried).marking(claude::transcript::decode_marked),
            minted: tab.provider_session_id.is_none().then_some(provider_id),
            transcript_root,
            conversation: Some(conversation),
            restart,
        })
    }

    /// Codex: the CLI mints its own conversation id and names the rollout
    /// after it, so a new tab has nothing to follow until its `SessionStart`
    /// hook says which file it opened. A tab that already holds an id follows
    /// that rollout from wherever it stands.
    #[allow(clippy::too_many_arguments)]
    fn codex_launch(
        &self,
        rt: &mut TabRuntime,
        entry: &index::SessionEntry,
        tab: &TabEntry,
        exe: &Path,
        env: &mut Vec<(String, String)>,
        grant: &crate::cloud_grants::LaunchGrant,
        on: &AccountLaunch,
    ) -> Result<CliLaunch> {
        let launcher = codex::pty::Launcher::resolve()?;
        let route = grant.route.as_ref();
        // A route's provider serves the model the route names (PRO-18), not
        // the account's list, so neither the tab's model nor a substitute
        // from that list is sent to it.
        let route_model = route.and_then(|route| route.model.clone());
        // A tab stored before the account's list was known can name a model
        // this account cannot run; sending it would fail the turn with a 400.
        let substitute = if route_model.is_some() { None } else { self.codex_models.substitute_for(&tab.model) };
        let model = match (route_model, substitute) {
            (Some(model), _) => model,
            (None, Some(sub)) => {
                let text = codex::models::substitution_notice(&tab.model, &sub);
                self.publish(rt, Payload::Status { text, handoff: None }, None);
                if let Err(error) = self.update_settings(rt, |s| s.model = sub.id.clone()) {
                    log::warn!("record the substituted Codex model: {error:#}");
                }
                sub.id
            }
            (None, None) => tab.model.clone(),
        };

        // An added account's managed home, which its grant names as
        // CODEX_HOME: built again here for whether its hooks are live.
        // Otherwise the default managed home, as before accounts.
        let codex::home::Prepared { home, hooks_live } = match (&on.id, &on.home) {
            (Some(id), Some(_)) => codex::home::prepare_account(&entry.cwd, exe, &store::root()?, id).context("prepare the account's Codex home")?,
            _ => {
                let prepared = codex::home::prepare(&entry.cwd, exe, grant.codex_auth.clone()).context("prepare the Codex home")?;
                env.push(("CODEX_HOME".to_string(), prepared.home.to_string_lossy().into_owned()));
                prepared
            }
        };
        if !hooks_live {
            // The hooks are what say a turn began, needs a decision, or ended.
            // Without them the chat is only the rollout, which never says the
            // turn is over — so say so rather than leave a turn spinning.
            let text = "Codex could not install its hooks here, so this tab shows the conversation but not its progress. The terminal view is unaffected.".to_string();
            self.publish(rt, Payload::Status { text, handoff: None }, None);
        }

        // A conversation started by native Codex or the old headless engine
        // lives in their home (in a cloud workspace native Codex's own, else
        // the reader's), where a `codex resume` against ours would not look.
        let mut resume = tab.provider_session_id.clone();
        if let Some(id) = &resume {
            for source in [codex::home::native_root_if_made(), codex::home::user_root()].into_iter().flatten() {
                match codex::home::adopt_rollout(&home, &source, id) {
                    Ok(true) => {
                        log::info!("brought Codex conversation {id} into the managed home");
                        break;
                    }
                    Ok(false) => {}
                    Err(e) => log::warn!("could not adopt Codex conversation {id}: {e:#}"),
                }
            }
        }
        let rollout = resume.as_deref().and_then(|id| codex::home::find_rollout(&home, id));
        // Resuming an id Codex cannot find fails the launch outright, so the
        // tab starts a new conversation, and says what that cost. A tab with
        // no id yet never had a rollout of its own: a prompt it sent that
        // Codex never took is all it can have lost (#663).
        let restart = rollout.is_none().then(|| unsent::restart(unsent::said_in(&rt.log_path, tab.follow.conversation.as_deref()), tab.continuation, resume.is_some())).flatten();
        if rollout.is_none() {
            resume = None;
        }
        // A run's worker is handed its limits at launch (`orchestration::guard`):
        // Codex reads a checkout's own rules, and applies them in bypass too.
        // Without them the worker does not start: bypass is safe only with them.
        if crate::orchestration::guard::limited(entry) {
            crate::orchestration::guard::write_codex_rules(Path::new(&entry.cwd)).context("write the run worker's deny rules")?;
        }
        let command = launcher.command(codex::pty::LaunchOptions {
            resume: resume.as_deref(),
            model: &model,
            effort: tab.effort.as_deref(),
            permission_mode: &tab.permission_mode,
        });
        // The route's model provider, as user-level overrides.
        let command = format!("{command}{}", route.map(|route| route.codex_args.as_str()).unwrap_or_default());
        Ok(CliLaunch {
            command,
            model: (model != tab.model).then_some(model),
            tail: match rollout {
                Some(path) => tui::Tail::opening(path, codex::rollout::decode_line, Default::default()).marking(codex::rollout::decode_marked),
                None => tui::Tail::unknown(codex::rollout::decode_line).marking(codex::rollout::decode_marked),
            },
            minted: None,
            // Codex names its own rollout, and only ever under the home
            // Raccoon built for it.
            transcript_root: home.join("sessions"),
            conversation: None,
            restart,
        })
    }

    /// Restart the CLI so it reads a setting it only takes at startup: the
    /// permission mode for either CLI, and the model and effort for Codex,
    /// which has no command for them. It is also how a CLI is put back in
    /// the tab's mode when it reports one it may not be in. The pane is kept and the conversation
    /// resumes, so what the reader sees is the CLI redrawing, not a new tab.
    ///
    /// The old process has to be *gone*, not merely signalled: it holds the
    /// conversation until it exits, and the replacement is refused a session
    /// another process still has.
    fn restart_for_settings(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let rt_arc = self.runtime(session_id, tab_id)?;
        let tail = match &rt_arc.lock().unwrap().engine {
            Engine::Cli(p) => p.tail.clone(),
            _ => return Ok(()),
        };
        self.restart_launch(&rt_arc, &tail)
    }

    fn restart_launch(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>) -> Result<()> {
        if let Some(work) = self.begin_restart_launch(rt_arc, tail)? {
            self.complete_cli_restart(rt_arc, work)?;
        }
        Ok(())
    }

    fn begin_restart_launch(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>) -> Result<Option<CliRestart>> {
        let mut rt = rt_arc.lock().unwrap();
        if !Self::has_tail(&rt, tail) { return Ok(None); }
        if let Some(refusal) = Self::by_hand_refusal(&rt, "its settings") { bail!(refusal); }
        Ok(self.prepare_cli_restart(&mut rt, tail, false))
    }

    /// A deferred settings restart must still be due and idle when its worker
    /// reserves the launch. A prompt may have started on this same tail since
    /// dispatch; keep its pending settings for the next completion in that case.
    fn begin_idle_restart_launch(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>) -> Option<CliRestart> {
        let mut rt = rt_arc.lock().unwrap();
        if rt.stopping || rt.turn_open || !Self::has_tail(&rt, tail)
            || !matches!(&rt.engine, Engine::Cli(p) if p.restart_when_idle && p.by_hand.is_none()) {
            return None;
        }
        self.prepare_cli_restart(&mut rt, tail, true)
    }

    /// Persist withdrawal before a launch can consume requested settings.
    /// The returned leases belong to the whole physical restart/launch.
    fn admit_pending_settings(&self, rt: &mut TabRuntime) -> Result<Vec<crate::data_privacy::RemoteWrite>> {
        let permits = Self::pending_configuration_permits(rt)?;
        let _policy: Vec<_> = permits.iter().map(|permit| permit.collaboration.try_enter_admission()
            .context("Collaboration policy is changing; retry the settings")).collect::<Result<_>>()?;
        let authority = rt.collaboration_settings.clone();
        let mut privacy = Vec::new();
        let (_, after) = self.update_settings(rt, |s| {
            s.retain_collaboration_requests(|id| authority.get(id).is_some_and(|permit| permit.check_configuration().is_ok()));
            privacy = s.admit_pending();
        })?;
        rt.collaboration_settings.retain(|id, _| after.collaboration_requests().values().any(|pending| pending == id));
        Ok(privacy)
    }

    fn remember_configuration(rt: &mut TabRuntime, settings: &Settings, key: &str, permit: Option<&CollaborationPermit>) {
        rt.collaboration_settings.retain(|id, _| settings.collaboration_requests().values().any(|pending| pending == id));
        if let (Some(id), Some(permit)) = (settings.collaboration_requests().get(key), permit) {
            rt.collaboration_settings.insert(id.clone(), permit.clone());
        }
    }

    fn pending_configuration_permits(rt: &TabRuntime) -> Result<Vec<CollaborationPermit>> {
        let entry = index::get(&rt.session_id)?;
        let settings = Settings::of(entry.tab(&rt.tab_id).context("tab not found")?);
        Ok(settings.collaboration_requests().values().filter_map(|id| rt.collaboration_settings.get(id).cloned()).collect())
    }

    fn prepare_cli_restart(&self, rt: &mut TabRuntime, tail: &Arc<tui::Tail>, idle: bool) -> Option<CliRestart> {
        if !Self::has_tail(rt, tail) || rt.restart_claim.is_some() { return None; }
        // Immediate phone operations also retain their initiating authority
        // through the process wait. Deferred work gets each request's ticket
        // from the index; unrelated edits never replace that authority.
        let mut privacy = match crate::data_privacy::remote_ticket().map(|ticket| ticket.enter()).transpose() {
            Ok(lease) => lease.into_iter().collect::<Vec<_>>(),
            Err(_) => return None,
        };
        match self.admit_pending_settings(rt) {
            Ok(leases) => privacy.extend(leases),
            Err(error) => { log::warn!("admit deferred settings: {error:#}"); return None; }
        }
        if idle {
            let tab = index::get(&rt.session_id).ok()?.tab(&rt.tab_id)?.clone();
            let Engine::Cli(p) = &mut rt.engine else { return None };
            p.restart_when_idle = tab.requested_permission_mode.is_some()
                || (p.harness == CliKind::Codex && (tab.requested_model.is_some() || tab.requested_effort.is_some()));
            if !p.restart_when_idle { return None; }
        }
        let pane = match &rt.engine { Engine::Cli(p) => p.pane_id.clone(), _ => return None };
        self.release_cli(rt);
        // Capture the actual group before dropping runtime. A later stop or
        // replacement can reuse the pane name without becoming this work's target.
        let process = self.terminals.begin_stop(&pane);
        rt.stopping_pid = process.as_ref().and_then(pty::StoppingPane::pid);
        self.retain_stopping_ptys(&key_of(&rt.session_id, &rt.tab_id), process.as_slice());
        rt.restart_claim = Some(tail.clone());
        Some(CliRestart { tail: tail.clone(), pane, process, _privacy: privacy })
    }

    fn claim_restart_completion<'a>(&self, rt_arc: &'a Arc<Mutex<TabRuntime>>, work: &CliRestart, exited: bool) -> Result<Option<MutexGuard<'a, TabRuntime>>> {
        let mut rt = rt_arc.lock().unwrap();
        if !rt.restart_claim.as_ref().is_some_and(|claim| Arc::ptr_eq(claim, &work.tail)) { return Ok(None); }
        rt.restart_claim = None;
        if exited {
            rt.stopping_pid = None;
            self.retire_stopping_ptys(&key_of(&rt.session_id, &rt.tab_id), work.process.as_slice());
        }
        // A followed agent or a shell may have taken the slot during the wait.
        if !matches!(rt.engine, Engine::None) || self.terminals.is_live(&work.pane) { return Ok(None); }
        if !exited {
            rt.stopping = true;
            self.needs_recovery(&mut rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
            bail!("Local process exit could not be confirmed. Retry Stop before resuming.");
        }
        rt.stopping_pid = None;
        if rt.stopping { bail!("Stop has not confirmed local process exit. Retry Stop before resuming."); }
        self.accepting_work()?;
        Ok(Some(rt))
    }

    fn complete_cli_restart(&self, rt_arc: &Arc<Mutex<TabRuntime>>, work: CliRestart) -> Result<()> {
        // No runtime lock is held across the process wait.
        let exited = work.process.as_ref().is_none_or(|process| process.wait(RESTART_WAIT));
        let Some(mut rt) = self.claim_restart_completion(rt_arc, &work, exited)? else { return Ok(()) };
        let entry = index::get(&rt.session_id)?;
        let tab = entry.tab(&rt.tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        self.start_cli(&mut rt, rt_arc, &entry, &tab, false)?;
        let now = index::get(&rt.session_id).ok().and_then(|entry| entry.tab(&rt.tab_id).map(Settings::of));
        if let (Engine::Cli(p), Some(now)) = (&mut rt.engine, now) {
            if p.harness == CliKind::Codex && p.launched_for.is_none() { p.launched_for = Some(now); }
        }
        self.schedule_held(&rt);
        Ok(())
    }

    /// Let go of the tab's CLI, keeping the conversation so the next prompt
    /// resumes. Returns the pane the caller must kill — outside the tab lock,
    /// because waiting for the process to go is a wait on another process.
    fn release_cli(&self, rt: &mut TabRuntime) -> Option<String> {
        let pane = self.let_go_of_cli(rt)?;
        self.set_status(rt, TabStatus::Idle);
        Some(pane)
    }

    /// [`Self::release_cli`], with the tab's status left for the caller to
    /// settle: a stop for idleness keeps a reply nobody has read unread.
    fn let_go_of_cli(&self, rt: &mut TabRuntime) -> Option<String> {
        rt.restart_claim = None;
        rt.background = None;
        let Engine::Cli(p) = &rt.engine else { return None };
        let pane = p.pane_id.clone();
        rt.left_at = Some((p.tail.path(), p.tail.offset()));
        // A new tab's first agent going: whether it went while starting is
        // what the window that opened the tab is told (PRO-291).
        let key = key_of(&rt.session_id, &rt.tab_id);
        if self.first_starts.starting(&key) {
            let went_starting = p.by_hand.is_none() && !rt.stopping && p.never_got_going() && !self.terminals.is_running(&pane);
            let failure = went_starting.then(|| self.startup_failure(&rt.harness, &pane));
            self.first_starts.exited(&key, failure, Instant::now());
        }
        crate::cloud_grants::forget_launch(&pane);
        for request_id in rt.pending.drain().map(|(id, _)| id).collect::<Vec<_>>() {
            self.publish(rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
        }
        rt.engine = Engine::None;
        self.retire_provider(rt);
        rt.turn_open = false;
        self.settle_settings_without_process(rt);
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
            manager.follow_by_hand(&rt_arc);
            if !manager.terminals.is_running(&pane) {
                if matches!(&rt_arc.lock().unwrap().engine, Engine::Cli(p) if p.generation == generation) {
                    manager.cli_gone(&rt_arc, &pane, None, TurnStatus::Aborted);
                }
                return;
            }
        });
    }

    /// Publish everything the transcript has gained since the last look. The
    /// tail's application lock covers managed-session draining through
    /// publication, so a hook cannot apply a later read ahead of the poll loop.
    fn pump(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>) {
        // A CLI the reader started by hand has no hook to close its turns:
        // the transcript does, so each record's word about the turn is acted
        // on where it stands, not only the last of a read (#437).
        if matches!(&rt_arc.lock().unwrap().engine, Engine::Cli(p) if p.by_hand.is_some()) {
            return self.pump_by_hand(rt_arc, tail);
        }
        self.pump_read_from(rt_arc, tail, || tail.drain_records());
    }

    /// A tab slot survives stop/restart; a tail belongs to exactly one launch.
    fn has_tail(rt: &TabRuntime, tail: &tui::Tail) -> bool {
        matches!(&rt.engine, Engine::Cli(p) if std::ptr::eq(p.tail.as_ref(), tail))
    }

    fn pump_read_from(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &tui::Tail, read: impl FnOnce() -> Vec<tui::Record>) {
        // Do not hold runtime while reading the file. This separate gate
        // orders readers through application, after the path/cursor locks
        // have been released. No caller may wait for it while holding runtime.
        let application = tail.application.lock().unwrap();
        self.pump_read_guarded(rt_arc, tail, read(), Some(application));
    }

    /// One read of the transcript: its payloads, and what it last said about
    /// the turn.
    fn pump_read(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &tui::Tail, records: Vec<tui::Record>) {
        self.pump_read_guarded(rt_arc, tail, records, None);
    }

    fn pump_read_guarded(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &tui::Tail, records: Vec<tui::Record>, application: Option<MutexGuard<'_, ()>>) {
        let mark = records.iter().rev().find_map(|(_, mark, _, _)| *mark);
        // Keep the preceding record's boundary for a command immediately after
        // a completed turn, even when both arrive in one tail read.
        let mut preceding_mark = None;
        let payloads: Vec<_> = records.into_iter().flat_map(|(payloads, mark, ts, lineage)| {
            let before = preceding_mark;
            if mark.is_some() { preceding_mark = mark; }
            // Marks with no payload still carry ordering: in particular an
            // abort followed by a continuation in this very same read.
            let boundary = mark.map(|mark| (None, ts.clone(), before, Some(mark), None));
            boundary.into_iter().chain(payloads.into_iter().map(move |payload| (Some(payload), ts.clone(), before, None, lineage.clone())))
        }).collect();
        if payloads.is_empty() && mark.is_none() {
            return;
        }
        let mut rt = rt_arc.lock().unwrap();
        // Reading (and waiting for another reader) may span a replacement.
        // Check before activity, receipt expiry, or any record is applied.
        if !Self::has_tail(&rt, tail) { return; }
        rt.last_activity = Instant::now();
        if let Engine::Cli(p) = &mut rt.engine {
            p.recorded = true;
        }
        if !payloads.is_empty() {
            rt.incidents.progress("transcript");
            self.stall_disproved(&mut rt);
        }
        let turn_open = rt.turn_open;
        let unsent = match &mut rt.engine {
            Engine::Cli(p) => p.expire_echoes(turn_open, Instant::now()),
            _ => Vec::new(),
        };
        self.queued_prompts_unsent(&mut rt, &unsent);
        for (payload, ts, preceding_mark, record_mark, lineage) in payloads {
            rt.source_timestamp = Some(ts);
            if let Some(mark) = record_mark {
                if matches!(&rt.engine, Engine::Cli(p) if p.harness == CliKind::Codex) {
                    match mark {
                        tui::TurnMark::Aborted => {
                            let already_closed = match &mut rt.engine {
                                Engine::Cli(p) => {
                                    p.codex_prompt_starts_turn = false;
                                    let closed = std::mem::take(&mut p.transcript_end_owed);
                                    p.transcript_turn = Some(mark);
                                    if !closed { p.codex_interrupt_hooks_owed += 1; }
                                    closed
                                }
                                _ => unreachable!(),
                            };
                            if !already_closed {
                                self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                            }
                        }
                        tui::TurnMark::Opened => {
                            if !rt.turn_open {
                                rt.prompt_taken("", "transcript_task_started");
                            }
                            if let Engine::Cli(p) = &mut rt.engine {
                                p.codex_prompt_starts_turn = true;
                                p.transcript_turn = Some(mark);
                                p.turn_tail.opened();
                            }
                            self.set_status(&mut rt, TabStatus::InProgress);
                        }
                        tui::TurnMark::Ended => {
                            let open = rt.turn_open;
                            if let Engine::Cli(p) = &mut rt.engine {
                                // A Stop hook can precede its own completion.
                                // Consume that debt here, before a later abort
                                // in this same read can mistake it for its own.
                                if !std::mem::take(&mut p.transcript_end_owed) {
                                    p.transcript_turn = open.then_some(mark);
                                }
                            }
                        }
                    }
                }
                continue;
            }
            let Some(payload) = payload else { continue };
            // Counted before anything can skip it: a reply the `Stop` hook
            // already drew is still work on the prompt before it.
            if let (Payload::AssistantText { .. } | Payload::Reasoning { .. } | Payload::ToolCallStarted { .. }, Engine::Cli(p)) = (&payload, &mut rt.engine) {
                p.prompts.worked_on();
            }
            let provider_prompt_starts_turn = if matches!(payload, Payload::UserMessage { .. }) {
                match &mut rt.engine {
                    Engine::Cli(p) => std::mem::take(&mut p.codex_prompt_starts_turn),
                    _ => false,
                }
            } else { false };
            // Where a prompt stands in the conversation, for the prompts
            // after it to be told by (#722).
            let prompt = match (&payload, lineage) {
                (Payload::UserMessage { text, .. }, Some(lineage)) => Some((lineage, text.clone())),
                _ => None,
            };
            // A prompt in the place of one the agent dropped unanswered: the
            // chat's message for that one, and what it said.
            let replaced = match (&prompt, &mut rt.engine) {
                (Some((lineage, _)), Engine::Cli(p)) => p.prompts.replaced_by(lineage).map(|dropped| (dropped.seq, dropped.text)),
                _ => None,
            };
            // A prompt sent from the composer was published when it was sent;
            // the transcript's copy of it would be the same message twice.
            // Anything else the transcript calls a prompt was typed into the
            // terminal, and this is the only record of it (#250). One typed
            // into an input box that held something, or held by the CLI with
            // others, reached the agent inside the prompt recorded here, which
            // the chat shows for it; so does one an idle CLI recorded changed
            // (#722).
            let mut unconfirmed: Vec<u64> = Vec::new();
            let echoed = match &mut rt.engine {
                Engine::Cli(p) => {
                    // What each awaited prompt said, to know a lapsed one by
                    // once a record is matched to it (#1385).
                    let awaited: Vec<(u64, String, usize)> = if matches!(payload, Payload::UserMessage { .. }) && !p.lapsed.0.is_empty() {
                        p.echoed.iter().map(|echo| (echo.seq, echo.text.clone(), echo.image_count)).collect()
                    } else {
                        Vec::new()
                    };
                    let echoed: Vec<Echoed> = if p.harness == CliKind::Codex {
                        consume_codex_queue_echo(&mut p.echoed, &payload)
                    } else if let Some(echo) = consume_composer_echo(&mut p.echoed, &payload) {
                        vec![echo]
                    } else {
                        let joined = consume_composer_echoes_within(&mut p.echoed, &payload);
                        if joined.is_empty() { consume_awaited_echo_changed(&mut p.echoed, p.awaiting_delivery, &payload).into_iter().collect() } else { joined }
                    };
                    // A queued prompt taken after its wait ran out (#1284),
                    // in the conversation it was sent to (#1335). Words the
                    // composer sent again were taken as that message: the
                    // lapsed one is not owed them any more.
                    let conversation = p.tail.path();
                    let echoed = if echoed.is_empty() {
                        p.lapsed.take(&payload, &conversation, Instant::now()).into_iter().collect()
                    } else {
                        let sent: Vec<(&str, usize)> = awaited.iter().filter(|(seq, ..)| echoed.iter().any(|echo| echo.seq == *seq)).map(|(_, text, images)| (text.as_str(), *images)).collect();
                        let recorded = match &payload { Payload::UserMessage { text, .. } => text.as_str(), _ => "" };
                        unconfirmed = p.lapsed.retire(&sent, recorded, &conversation, Instant::now());
                        echoed
                    };
                    if !echoed.is_empty() {
                        forget_taken(p);
                    }
                    if let (Some((lineage, text)), Some(echo)) = (&prompt, echoed.first()) {
                        p.prompts.record(lineage.clone(), echo.seq, text.clone());
                    }
                    echoed
                }
                _ => Vec::new(),
            };
            // A lapsed card the same words sent again took the place of
            // (#1386): whether the CLI took it too is not known.
            for seq in unconfirmed {
                self.publish(&mut rt, Payload::PromptWithdrawn { prompt_seq: seq, unconfirmed: true }, None);
            }
            if let (Some((dropped, said)), Some((lineage, text))) = (&replaced, &prompt) {
                // The same words as the dropped prompt, and no message sent
                // from the chat says them: sent again from the input box the
                // agent had put it back in, it is still the one message. One
                // sent from the chat with those words is a message of its
                // own, and the dropped one was never answered.
                if echoed.is_empty() && same_words(said, text) {
                    self.prompt_sent_again(&mut rt, *dropped, text);
                    if let Engine::Cli(p) = &mut rt.engine {
                        p.prompts.record(lineage.clone(), *dropped, text.clone());
                    }
                    continue;
                }
                self.publish(&mut rt, Payload::PromptReplaced { prompt_seq: *dropped }, None);
            }
            match (&payload, &mut rt.engine) {
                // Whose command the next "Set model to …" answers: one that
                // came back as an echo was sent from here.
                (Payload::UserMessage { text, .. }, Engine::Cli(p)) if text.starts_with("/model") || text.starts_with("/effort") => {
                    p.settings_command_is_ours = !echoed.is_empty();
                }
                // The answer to a command typed in the terminal says nothing
                // about a change the app is still waiting on.
                (Payload::ProviderSettings { signal: Signal::Accepted { .. } }, Engine::Cli(p)) if !p.settings_command_is_ours => continue,
                _ => {}
            }
            if !echoed.is_empty() {
                for (index, echo) in echoed.into_iter().enumerate() {
                    if matches!(&rt.engine, Engine::Cli(p) if p.awaiting_delivery == Some(echo.seq)) {
                        self.delivery_confirmed(&mut rt);
                    }
                    // Received inside the prompt of an earlier message, which
                    // shows it: nothing of its own is left to draw or start.
                    if let Some(into_seq) = echo.into {
                        self.publish(&mut rt, Payload::PromptJoined { prompt_seq: echo.seq, into_seq }, None);
                        continue;
                    }
                    // What the agent received, in place of what was sent.
                    if let (true, Payload::UserMessage { text, .. }) = (echo.changed, &payload) {
                        self.publish(&mut rt, Payload::PromptChanged { prompt_seq: echo.seq, text: text.clone() }, None);
                    }
                    // Its waiter may have stopped waiting: a handoff the reader
                    // sent with Enter after the dialog said it was in the input.
                    if echo.continuation {
                        self.tell_delivery(&rt.session_id, &rt.tab_id, echo.seq, "delivered");
                    }
                    // A queued prompt the CLI held until its turn was over is the
                    // start of the next one. The `UserPromptSubmit` hook may have
                    // opened that turn already, but only a prompt resets the latch
                    // that lets `Stop` close it, and this record is that prompt.
                    // So is one the CLI took after work it did first (#540), or
                    // the first accepted message after Codex's task_started.
                    // So is one that took the place of a prompt the agent
                    // dropped (#722): it is what the agent is answering now.
                    let starts_turn = echo.overtaken || (index == 0 && replaced.is_some()) || (echo.queued && (!rt.turn_open || (index == 0 && provider_prompt_starts_turn) || matches!(&rt.engine, Engine::Cli(p) if p.turn_tail.is_closed())));
                    if starts_turn {
                        if !rt.turn_open {
                            if let Payload::UserMessage { text, .. } = &payload {
                                rt.prompt_taken(text, "transcript_queued_prompt");
                            }
                        }
                        if let Engine::Cli(p) = &mut rt.engine {
                            p.turn_tail.opened();
                        }
                        // The message itself is not published again; this says
                        // which one the new turn is the answer to.
                        self.publish(&mut rt, Payload::TurnStarted { model: None, provider_session_id: None, prompt_seq: Some(echo.seq), started_by: None, initiating_prompt: None }, None);
                        self.set_status(&mut rt, TabStatus::InProgress);
                    } else if echo.queued {
                        // Taken within the turn it was queued behind (#551). The
                        // chat would otherwise go on showing it as waiting, and
                        // fold it away with the tool calls once the turn is over.
                        self.publish(&mut rt, Payload::PromptAbsorbed { prompt_seq: echo.seq }, None);
                    }
                }
                // A `!` command recorded with its output in the same record
                // (#1294): the echo was the command, and the output is still
                // to be drawn, under the `!command` the composer published.
                if let Some(output) = shell_output_of_echo(&rt, &payload) {
                    self.shell_settled(&mut rt);
                    self.apply(&mut rt, output, None);
                }
                continue;
            }
            if let (Payload::AssistantText { text, .. }, Engine::Cli(p)) = (&payload, &mut rt.engine) {
                if !p.turn_tail.observe(text) {
                    continue; // the app already said this for a Stop hook
                }
            }
            if matches!(payload, Payload::ContextCompacted { .. }) {
                rt.compact_completed = true;
                rt.compact_boundary_at = rt.source_timestamp.as_deref().and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok());
            }
            // Model/tool work is not a bare command, even after compaction.
            if matches!(payload, Payload::AssistantText { .. } | Payload::Reasoning { .. } | Payload::ToolCallStarted { .. }) {
                // The agent took up a `!` command's output after all (#1294):
                // its turn is the agent's now, and ends as any other does,
                // not at the output that settled the command.
                if rt.turn_by_command {
                    if let Engine::Cli(p) = &mut rt.engine {
                        p.transcript_turn = None;
                    }
                }
                rt.turn_by_command = false;
            }
            if let Payload::UserMessage { text, .. } = &payload {
                if rt.repeats_completed_compact(text) {
                    self.apply(&mut rt, payload, None);
                    continue;
                }
                // Claude Code's record of a `!` command (#1294) is no prompt:
                // it opens no turn, and its output ends the one a `!command`
                // from the composer opened.
                if rt.harness == "claude" {
                    if let Some(shell) = claude::transcript::shell_record(text) {
                        if shell.output {
                            self.shell_settled(&mut rt);
                        }
                        self.apply(&mut rt, payload, None);
                        continue;
                    }
                }
                self.delivery_confirmed(&mut rt);
                // A prompt typed into the terminal with no hook ahead of it
                // (a CLI started by hand, #437) is where its turn's time is
                // counted from.
                if text.split_whitespace().next() == Some("/compact") && preceding_mark.is_some_and(tui::TurnMark::ends) {
                    if let Engine::Cli(p) = &mut rt.engine {
                        if !p.transcript_end_owed { p.transcript_turn = preceding_mark; }
                    }
                }
                rt.prompt_taken(text, "transcript_user_message");
                if let Engine::Cli(p) = &mut rt.engine {
                    p.turn_tail.opened();
                }
                self.set_status(&mut rt, TabStatus::InProgress);
            }
            // A turn the CLI started itself (#540) is a turn like any other
            // from here: the tab is working, a message sent now is queued
            // behind it, and `Stop` closes it. Nobody's prompt was delivered.
            if matches!(payload, Payload::TurnStarted { started_by: Some(_), .. }) {
                rt.prompt_taken("", "transcript_turn_started");
                if let Engine::Cli(p) = &mut rt.engine {
                    p.turn_tail.opened();
                }
                self.set_status(&mut rt, TabStatus::InProgress);
            }
            // The CLI's own work, read before its record of a prompt the
            // composer sent: that prompt is not what it was answering.
            if matches!(payload, Payload::AssistantText { .. } | Payload::Reasoning { .. } | Payload::ToolCallStarted { .. } | Payload::TurnStarted { started_by: Some(_), .. }) {
                if let Engine::Cli(p) = &mut rt.engine {
                    overtake_composer_prompts(&mut p.echoed, &p.held);
                }
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
            // A prompt typed in the terminal: the message just published.
            let published = rt.seq;
            if let (Some((lineage, text)), Engine::Cli(p)) = (prompt, &mut rt.engine) {
                p.prompts.record(lineage, published, text);
            }
        }
        rt.source_timestamp = None;
        // No hook closes the turn of a CLI the reader started by hand (#437),
        // so the transcript's own word that it ended is taken at once. It is
        // read after the payloads, so the turn's reply is in it.
        if mark.is_some_and(tui::TurnMark::ends) && rt.turn_open && matches!(&rt.engine, Engine::Cli(p) if p.by_hand.is_some()) {
            let said = match &rt.engine {
                Engine::Cli(p) => p.turn_tail.last_assistant_message().map(str::to_owned),
                _ => None,
            };
            if mark == Some(tui::TurnMark::Aborted) {
                // Interrupted in its own screen: not a turn that finished.
                self.end_open_turn(&mut rt, TurnStatus::Aborted, None);
                let (session, tab) = (rt.session_id.clone(), rt.tab_id.clone());
                drop(rt);
                drop(application);
                self.observer.automation_failed(&session, &tab, "The automation turn was interrupted.");
            } else {
                let completed = (rt.turn_generation, rt.turn_started_at, chrono::Utc::now());
                self.end_open_turn(&mut rt, TurnStatus::Ok, None);
                drop(application);
                self.after_turn_completed(rt_arc, rt, said, completed);
            }
            self.judge_reported_mode(rt_arc, tail);
            return;
        }
        // Recorded after the payloads, so an end never gets ahead of the
        // reply before it, and only against an open turn: the end of a turn
        // the hooks already closed says nothing about the next one. That
        // holds when the next one has opened in the meantime too, which is
        // what `transcript_end_owed` is for: a prompt sent right after `Stop`
        // is open before the transcript gets round to the turn before it.
        let open = rt.turn_open;
        if let (Some(mark), Engine::Cli(p)) = (mark, &mut rt.engine) {
            // Codex boundaries were reconciled in record order above. In
            // particular, an Opened marker must not consume an owed end.
            if p.harness != CliKind::Codex {
                let owed = std::mem::take(&mut p.transcript_end_owed);
                if !(owed && mark.ends()) {
                    p.transcript_turn = open.then_some(mark);
                }
            }
        }
        // Only record application is serialized. Policy reconciliation takes
        // sharing and can restart a provider: release both guards first.
        drop(rt);
        drop(application);
        self.judge_reported_mode(rt_arc, tail);
    }

    /// The agent took up again the message at `seq`, which it had dropped
    /// unanswered and put back in its input box (#722): sent from there as
    /// it was. It is the message the chat already has, now the start of the
    /// agent's turn, not a second one.
    fn prompt_sent_again(&self, rt: &mut TabRuntime, seq: u64, text: &str) {
        self.delivery_confirmed(rt);
        if !rt.turn_open {
            rt.prompt_taken(text, "transcript_prompt_sent_again");
            self.publish(rt, Payload::TurnStarted { model: None, provider_session_id: None, prompt_seq: Some(seq), started_by: None, initiating_prompt: None }, None);
        }
        if let Engine::Cli(p) = &mut rt.engine {
            p.turn_tail.opened();
        }
        self.set_status(rt, TabStatus::InProgress);
    }

    /// Wait, briefly, for the transcript to deliver the reply the `Stop` hook
    /// is already holding. If it never comes, publish it here and mark its
    /// record to be dropped when it lands, so it is drawn exactly once.
    fn settle_reply(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>, want: Option<&str>) {
        let Some(want) = want.map(str::trim).filter(|w| !w.is_empty()) else { return };
        let saw = |rt: &TabRuntime| matches!(&rt.engine, Engine::Cli(p) if p.turn_tail.saw(want));
        let deadline = Instant::now() + tui::STOP_SETTLE;
        loop {
            {
                let rt = rt_arc.lock().unwrap();
                if !Self::has_tail(&rt, tail) || saw(&rt) { return; }
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(tui::POLL_INTERVAL);
            self.pump(rt_arc, tail);
        }
        let mut rt = rt_arc.lock().unwrap();
        // The poll thread may have landed it, or the launch may have changed.
        if !Self::has_tail(&rt, tail) || saw(&rt) {
            return;
        }
        let Engine::Cli(p) = &mut rt.engine else { return };
        p.turn_tail.anticipate(want);
        self.apply(&mut rt, Payload::AssistantText { block: None, text: want.to_string() }, None);
    }

    /// A `!` command's output came (#1294). The turn a `!command` from the
    /// composer opened ends with it, once the tab has been quiet for a moment
    /// (`watch_tabs`): Claude Code runs no model turn and no `Stop` for it.
    /// A turn the agent was already working on is left to end on its own.
    fn shell_settled(&self, rt: &mut TabRuntime) {
        if rt.turn_open && rt.turn_by_command {
            if let Engine::Cli(p) = &mut rt.engine {
                p.transcript_turn = Some(tui::TurnMark::Ended);
            }
        }
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

    /// Close the open turn of a CLI that exited before it ever worked
    /// (#667): it failed, with the line the CLI left as its reason, and as a
    /// refused sign-in when that line says so. The latch as for
    /// [`Self::close_open_turn`].
    fn fail_open_turn(&self, rt: &mut TabRuntime, exit: &recovery::EarlyExit) {
        rt.setup_failed = true;
        if !rt.turn_open {
            return;
        }
        if let Engine::Cli(p) = &mut rt.engine {
            if !p.turn_tail.closing() {
                return;
            }
        }
        let duration_ms = rt.turn_started_at.map(|t| t.elapsed().as_millis() as u64);
        let final_text = exit.sign_in_refused.then(|| RecoveryKind::SignedOut.message().to_string());
        let payload = Payload::TurnCompleted { status: TurnStatus::Error, final_text, usage: None, duration_ms, head: None, auth_failed: exit.sign_in_refused, detail: exit.detail.clone() };
        self.apply(rt, payload, None);
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
        self.apply(rt, Payload::TurnCompleted { status, final_text, usage: None, duration_ms, head: None, auth_failed: false, detail: None }, None);
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
        self.start_cli(rt, rt_arc, entry, tab, true)?;
        let (pane, ready, stops) = match &rt.engine {
            Engine::Cli(p) => (p.pane_id.clone(), p.ready.clone(), p.input.stops),
            _ => bail!("the agent is not running"),
        };
        let paths: Vec<String> = images.iter().map(|i| i.url.clone()).collect();
        let agent = prompt.agent.clone();
        let (ev, queued) = self.record_composer_prompt(rt, &prompt, images, &entry.cwd, receipt.clone());
        // Only a continuation waits on a receipt. It is the tab's whole
        // brief: a launch that finds the CLI never took it sends it again.
        if receipt.is_some() {
            if let Err(error) = index::update_tab(&rt.session_id, &rt.tab_id, |t| {
                t.continuation = Some(ev.seq);
                Ok(())
            }) {
                log::warn!("record the continuation prompt of {}: {error:#}", rt.key());
            }
        }
        if let Engine::Cli(cli) = &rt.engine {
            let pending: std::collections::HashSet<_> = cli.echoed.iter().map(|echo| echo.seq).collect();
            rt.collaboration_prompts.retain(|seq, _| pending.contains(seq));
        }
        if let Some(permit) = &prompt.collaboration { rt.collaboration_prompts.insert(ev.seq, permit.clone()); }
        self.type_prompt(rt_arc, &pane, agent, paths, PromptDelivery {
            collaboration: prompt.collaboration,
            ready: Some(ready),
            seq: Some(ev.seq),
            queued,
            stops,
            receipt: receipt.map(|receipt| (ev.seq, receipt)),
            mobile: prompt.mobile.map(|permit| (permit, entry.id.clone(), tab.id.clone(), ev.seq)),
            shared: prompt.shared_connection.map(|connection| (connection, entry.id.clone(), tab.id.clone(), ev.seq)),
        });
        Ok(SendOutcome { queued, events: vec![ev], in_input: false })
    }

    /// The composer's half of a prompt: publish it, open the turn if none is
    /// running, and remember that the CLI's own record of it is still to
    /// come, so that record is not drawn as a second message; one queued
    /// behind a turn is held until then. Everything except the keystrokes.
    fn record_composer_prompt(&self, rt: &mut TabRuntime, prompt: &PromptText, images: Vec<ImageRef>, cwd: &str, receipt: Option<DeliveryReceipt>) -> (AgentEvent, bool) {
        // Nothing is running behind a command that never ended.
        let queued = rt.turn_open && !rt.turn_by_command;
        let baseline = if queued { None } else { rt.baseline_for(cwd) };
        let (message, mut echo) = cli_composer_message(prompt, images, baseline, queued, cwd);
        let ev = self.publish_prompt(rt, message, prompt.request_id);
        echo.continuation = receipt.is_some();
        echo.receipt = receipt;
        echo.seq = ev.seq;
        self.await_composer_echo(rt, echo, &prompt.agent);
        (ev, queued)
    }

    /// A composer prompt the chat has published, from there on: its echo is
    /// awaited, and it opens a turn unless one is running.
    fn await_composer_echo(&self, rt: &mut TabRuntime, echo: ComposerEcho, agent_text: &str) {
        let (queued, seq) = (echo.queued, echo.seq);
        if let Engine::Cli(p) = &mut rt.engine {
            p.expire_echoes(queued, Instant::now());
            p.echoed.push_back(echo);
            if queued {
                forget_taken(p);
                p.held.push(seq);
            } else {
                p.turn_tail.opened();
                p.awaiting_delivery = Some(seq);
                p.delivery_sent_at = Some(Instant::now());
                p.accept_by = None;
                p.nudge_by = None;
                p.nudges_left = 0;
                p.entered_at = None;
            }
        }
        if !queued {
            rt.prompt_taken(agent_text, "composer");
            self.set_status(rt, TabStatus::InProgress);
        }
        // Sent while a delivery waits on the input box: it waits behind it,
        // and is said to (#722).
        if matches!(&rt.engine, Engine::Cli(p) if p.input.waiting) {
            if let Engine::Cli(p) = &mut rt.engine {
                p.input.marks.push(seq);
            }
            let choice = matches!(&rt.engine, Engine::Cli(p) if p.input.choice);
            self.publish(rt, Payload::InputOccupied { prompt_seq: seq, occupied: true, choice }, None);
            self.wait_on_reader_for_input(rt);
        }
    }

    /// Write into a pane on its own thread, under that pane's write lock. The
    /// Enter has to be a later *read* than the body — a carriage return the
    /// CLI takes in the same gulp as the paste is read as part of it and never
    /// submits — so this waits for the CLI to have read the paste and then
    /// sleeps, which no caller holding the tab lock could afford to do.
    ///
    /// Writing the Enter is still not delivery. A composer prompt's stages
    /// are noted in the tab's diagnostics as they pass, a continuation's are
    /// told to the dialog that sent it, and the Enter is written again while
    /// the CLI has not acknowledged it (`nudge_by`); the watcher tells the
    /// reader when it never does (`accept_by`).
    fn type_prompt(&self, rt_arc: &Arc<Mutex<TabRuntime>>, pane: &str, text: String, attachments: Vec<String>, delivery: PromptDelivery) {
        let PromptDelivery { ready, seq, queued, receipt, shared, mobile, stops, collaboration } = delivery;
        let sent_at = Instant::now();
        // A slash command opens a palette or runs in the CLI itself: it is
        // held to acknowledging nothing. A continuation is held to it like any
        // prompt, and only reports through its own receipt (#662).
        let watched = ready.is_some() && !queued && !tui::is_slash_command(&text);
        let continuation = receipt.is_some();
        // Taken here, while the sender still has the tab, so it is the order
        // the prompts were sent in.
        let ticket = self.writers.lock().unwrap().entry(pane.to_string()).or_default().ticket();
        let privacy = crate::data_privacy::remote_ticket();
        let terminals = self.terminals.clone();
        let manager = self.clone();
        let rt_arc = rt_arc.clone();
        let pane = pane.to_string();
        let spawn_receipt = receipt.clone();
        let spawned = std::thread::Builder::new().name("cli-input".into()).spawn(move || {
            let diagnostics = seq.map(|seq| {
                let rt = rt_arc.lock().unwrap();
                (seq, rt.diagnostics_path(), rt.session_id.clone(), rt.tab_id.clone())
            });
            let stage = |stage: &str, mut detail: serde_json::Value| {
                if let Some((seq, path, session_id, tab_id)) = &diagnostics {
                    detail["queued"] = queued.into();
                    recovery::diagnose_delivery(path, *seq, stage, sent_at.elapsed(), detail);
                    // Readiness is told by what follows it: the typing, or
                    // the receipt's error.
                    if continuation && stage != "ready" {
                        manager.tell_delivery(session_id, tab_id, *seq, stage);
                    }
                }
            };
            // The reader has stopped the turn since this message was sent. A
            // command the app types for itself is not part of a turn, and is
            // only held to a stop while it waits on the input box (#722).
            let stopped = |rt: &TabRuntime| seq.is_some() && matches!(&rt.engine, Engine::Cli(p) if p.input.stops != stops);
            // Let go of only while waiting on the input box, so an earlier
            // prompt's Enter can still be written again (`enter_again`).
            let mut held = Some(ticket.take());
            // A CLI the reader started by hand shares its pane with the shell
            // it was started from (#437). Once it has exited or been
            // suspended, anything typed here is typed at that shell, and the
            // Enter would run a prompt as a command. So the pane is asked who
            // has it before every write, the Enter above all; the watcher
            // that turns the tab into a terminal may be a moment behind.
            let still_there = || match manager.left_the_terminal(&rt_arc.lock().unwrap()) {
                Some(left) => Err(anyhow::Error::new(follow::Refusal(left))),
                None => Ok(()),
            };
            let policy_revoked = || collaboration.as_ref().is_some_and(|permit| Self::check_collaboration_permit(permit, &rt_arc.lock().unwrap()).is_err());
            if let Some(ready) = &ready {
                let readiness = manager.wait_ready(&pane, ready, shared.as_ref(), mobile.as_ref(), || privacy.as_ref().is_some_and(|ticket| !ticket.valid()) || policy_revoked() || stopped(&rt_arc.lock().unwrap()));
                stage("ready", serde_json::json!({ "readiness": readiness.as_str() }));
                let mut rt = rt_arc.lock().unwrap();
                // Stop or a restart may have replaced the CLI while waiting.
                if !matches!(&rt.engine, Engine::Cli(p) if Arc::ptr_eq(&p.ready, ready)) {
                    return;
                }
                if let (Readiness::Stopped, Some(seq)) = (readiness, seq) {
                    manager.prompt_withdrawn(&mut rt, seq, receipt.map(|(_, receipt)| receipt));
                    return;
                }
                if readiness == Readiness::Cancelled {
                    if let Some((_, _, _, seq)) = &shared { manager.cancel_shared_prompt(&mut rt, *seq); }
                    if let Some((_, _, _, seq)) = &mobile { manager.cancel_shared_prompt(&mut rt, *seq); }
                    if let (Some(_), Some(seq)) = (&privacy, seq) { manager.cancel_shared_prompt(&mut rt, seq); }
                    if let (Some(_), Some(seq)) = (&collaboration, seq) { manager.cancel_shared_prompt(&mut rt, seq); }
                    manager.refuse_continuation(&mut rt, receipt);
                    return;
                }
                if !manager.prepare_prompt(&mut rt, readiness, receipt.as_ref().map(|(_, receipt)| receipt)) {
                    return;
                }
            }
            // Nothing is typed into an input box that holds something: the
            // Enter would send that and this prompt as one (#722).
            let revoked = || privacy.as_ref().is_some_and(|ticket| !ticket.valid()) || policy_revoked() || manager.delivery_revoked(shared.as_ref(), mobile.as_ref());
            let input = match manager.wait_for_empty_input(&rt_arc, &pane, seq, stops, &ticket, &mut held, revoked, &stage) {
                InputWait::Type(input) => input,
                InputWait::Revoked => {
                    let mut rt = rt_arc.lock().unwrap();
                    if seq.is_none() { manager.command_not_typed(&mut rt, &text); }
                    if let Some((_, _, _, seq)) = &shared { manager.cancel_shared_prompt(&mut rt, *seq); }
                    if let Some((_, _, _, seq)) = &mobile { manager.cancel_shared_prompt(&mut rt, *seq); }
                    if let (Some(_), Some(seq)) = (&privacy, seq) { manager.cancel_shared_prompt(&mut rt, seq); }
                    if let (Some(_), Some(seq)) = (&collaboration, seq) { manager.cancel_shared_prompt(&mut rt, seq); }
                    manager.refuse_continuation(&mut rt, receipt);
                    return;
                }
                InputWait::Gone => return,
                InputWait::Refused => {
                    manager.command_not_typed(&mut rt_arc.lock().unwrap(), &text);
                    return;
                }
                InputWait::Withdrawn => {
                    let mut rt = rt_arc.lock().unwrap();
                    match seq {
                        Some(seq) => manager.prompt_withdrawn(&mut rt, seq, receipt.map(|(_, receipt)| receipt)),
                        None => manager.command_not_typed(&mut rt, &text),
                    }
                    return;
                }
            };
            // The last look before anything is typed: a stop since this was
            // sent withdraws it, whatever it waited on (#746). From here on
            // the stop is an Escape for the CLI, and holds back the Enter.
            if let Some(seq) = seq {
                let mut rt = rt_arc.lock().unwrap();
                if stopped(&rt) {
                    manager.prompt_withdrawn(&mut rt, seq, receipt.map(|(_, receipt)| receipt));
                    return;
                }
                if let Engine::Cli(p) = &mut rt.engine {
                    if let Some(echo) = p.echoed.iter_mut().find(|echo| echo.seq == seq) {
                        echo.typing = true;
                    }
                }
            }
            let mut admitted_to_writer = false;
            // Whether the Enter was written: not after a stop (#746).
            let result = (|| -> Result<bool> {
                let _control = privacy.as_ref().map(|ticket| ticket.enter()).transpose()?;
                let _privacy = shared.as_ref().map(|(permit, _, _, _)| permit.privacy.enter()).transpose()?;
                let mut sharing = (shared.is_some() || mobile.is_some()).then(|| manager.sharing.lock().unwrap());
                let mut owner_attachment = None;
                if let (Some((connection, session_id, tab_id, _)), Some(sharing)) = (&shared, &mut sharing) {
                    let share = sharing.sessions.get_mut(session_id).ok_or_else(|| anyhow!("Sharing ended before prompt delivery."))?;
                    share.admit_at_writer(connection, tab_id, chrono::Utc::now().timestamp_millis())?;
                    owner_attachment = share.owner.as_ref().map(|owner| owner.attachment.clone());
                    let current = index::get(session_id)?;
                    let tab = current.tab(tab_id).ok_or_else(|| anyhow!("Tab closed before prompt delivery."))?;
                    if !settings::allowed_while_shared(&tab.permission_mode) || manager.pane_of(session_id, tab_id).is_none_or(|current| current.pane_id != pane) {
                        bail!("The shared tab changed before prompt delivery.");
                    }
                }
                let _mobile = mobile.as_ref().map(|(permit,_,_,_)| permit.enter()).transpose()?;
                if let Some((permit, session, tab, _)) = &mobile {
                    permit.check_mode(session, tab)?;
                    if manager.pane_of(session, tab).is_none_or(|current| current.pane_id != pane) {
                        bail!("The mobile terminal instance changed before delivery.");
                    }
                }
                let _owner_attachment = owner_attachment.as_ref().map(|attachment| attachment.enter()).transpose()?;
                admitted_to_writer = true;
                still_there()?;
                for path in &attachments {
                    manager.write_collaboration_prompt(&rt_arc, collaboration.as_ref(), ready.as_ref(), &pane, &tui::attachment_bytes(path))?;
                }
                let unread = || terminals.unread_input(&pane);
                if !attachments.is_empty() {
                    let _ = tui::await_read(unread, tui::PASTE_READ_TIMEOUT);
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
                let body = tui::body_bytes(&text);
                still_there()?;
                manager.write_collaboration_prompt(&rt_arc, collaboration.as_ref(), ready.as_ref(), &pane, &body)?;
                stage("body_written", serde_json::json!({ "bytes": body.len(), "attachments": attachments.len(), "input": input }));
                let (read, read_after) = tui::await_read(unread, tui::PASTE_READ_TIMEOUT);
                if read == tui::PasteRead::Unread {
                    log::warn!("[{pane}] the CLI has not read the prompt; submitting anyway and watching for acceptance");
                }
                // Read is not yet taken in: a CLI busy with what it just
                // read, as one up for a second or two is with a long paste,
                // can lose an Enter it reads then (#662). It has the paste
                // once it has drawn since, its composer showing it.
                let drawn = tui::await_drawn(|| terminals.last_output(&pane), read_after, tui::PASTE_DRAW_TIMEOUT);
                if !drawn {
                    log::warn!("[{pane}] the CLI read the prompt but has drawn nothing since; submitting anyway");
                }
                std::thread::sleep(tui::submit_delay(body.len()).saturating_sub(read_after.elapsed()));
                still_there()?;
                if !manager.submit_collaboration_prompt(&rt_arc, collaboration.as_ref(), &pane, (seq, receipt.as_ref().map(|(seq, _)| *seq)), watched, |rt| stopped(rt) || ready.as_ref().is_some_and(|ready| !matches!(&rt.engine, Engine::Cli(cli) if Arc::ptr_eq(ready, &cli.ready))))? {
                    return Ok(false);
                }
                stage("submit_written", serde_json::json!({ "paste": read.as_str(), "drawn": drawn }));
                Ok(true)
            })();
            if let (Ok(false), Some(seq)) = (&result, seq) {
                // Stopped while it was being typed: what reached the input box
                // stays there for the reader, and is not sent (#746).
                log::info!("[{pane}] the turn was stopped before its prompt was entered");
                manager.prompt_withdrawn(&mut rt_arc.lock().unwrap(), seq, receipt.map(|(_, receipt)| receipt));
                return;
            }
            if let Err(e) = result {
                log::warn!("[{pane}] write: {e:#}");
                let mut rt = rt_arc.lock().unwrap();
                if !admitted_to_writer && seq.is_none() && privacy.is_some() {
                    manager.command_not_typed(&mut rt, &text);
                    return;
                }
                if !admitted_to_writer && (privacy.is_some() || shared.is_some() || mobile.is_some()) {
                    if let Some((_, _, _, seq)) = &shared { manager.cancel_shared_prompt(&mut rt, *seq); }
                    if let Some((_, _, _, seq)) = &mobile { manager.cancel_shared_prompt(&mut rt, *seq); }
                    if let (Some(_), Some(seq)) = (&privacy, seq) { manager.cancel_shared_prompt(&mut rt, seq); }
                    if let (Some(_), Some(seq)) = (&collaboration, seq) { manager.cancel_shared_prompt(&mut rt, seq); }
                    manager.refuse_continuation(&mut rt, receipt);
                    return;
                }
                if ready.as_ref().is_some_and(|ready| !matches!(&rt.engine, Engine::Cli(p) if Arc::ptr_eq(&p.ready, ready))) {
                    return;
                }
                if let Some((_, receipt)) = receipt {
                    rt.turn_open = false;
                    manager.set_status(&mut rt, TabStatus::Idle);
                    let _ = receipt.send(Err(format!("The new session opened, but writing its continuation prompt failed: {e}. The prepared prompt is retained.")));
                } else if e.is::<follow::Refusal>() {
                    // Nothing to recover: the tab is becoming a terminal, and
                    // the watcher closes the turn this prompt opened and
                    // says the agent went.
                } else if ready.is_some() && matches!(&rt.engine, Engine::Cli(p) if p.awaiting_delivery.is_some()) {
                    manager.needs_recovery(&mut rt, RecoveryKind::DeliveryUnconfirmed, crate::recovery_log::Source::Delivery);
                    rt.stalled_at = Some(Instant::now());
                }
            }
        });
        if let (Err(e), Some((_, receipt))) = (spawned, spawn_receipt) {
            let _ = receipt.send(Err(format!("Could not start prompt delivery: {e}")));
        }
    }

    /// Enter and its delivery identities become visible together. A provider
    /// can echo a combined queue as soon as it reads Enter; the transcript
    /// reader must not consume that record while an identity is still unarmed.
    ///
    /// `watched`: the CLI is held to acknowledging the prompt, and given the
    /// Enter again until it does.
    ///
    /// `stopped`: the reader has stopped the turn since the prompt was sent,
    /// and its Enter is not written (#746). Asked under the same lock as an
    /// interrupt's, so a stop is either before the Enter or its Escape after.
    /// `false` when the Enter was held back.
    fn submit_composer_prompt(rt_arc: &Arc<Mutex<TabRuntime>>, seq: Option<u64>, receipt_seq: Option<u64>, watched: bool, stopped: impl FnOnce(&TabRuntime) -> bool, write: impl FnOnce() -> Result<()>) -> Result<bool> {
        let mut rt = rt_arc.lock().unwrap();
        if stopped(&rt) {
            return Ok(false);
        }
        write()?;
        if let Engine::Cli(p) = &mut rt.engine {
            for seq in receipt_seq.into_iter().chain(seq) {
                if let Some(echo) = p.echoed.iter_mut().find(|echo| echo.seq == seq) {
                    echo.submitted = true;
                }
            }
            if let Some(seq) = seq {
                if watched && p.awaiting_delivery == Some(seq) {
                    let now = Instant::now();
                    // A continuation's receipt tells the dialog that sent it
                    // what became of it; the tab does not tell it again.
                    if receipt_seq.is_none() {
                        p.accept_by = Some(now + tui::ACCEPT_TIMEOUT);
                    }
                    p.nudge_by = Some(now + tui::NUDGE_AFTER);
                    p.nudges_left = tui::NUDGES;
                    p.entered_at = Some(now);
                }
            }
        }
        Ok(true)
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

    /// A phone's or share's handoff refused before a byte of it was typed:
    /// the dialog that sent it is told it was not delivered, and the tab
    /// keeps no brief a later launch would send again under the host's
    /// authority. No banner: nothing failed that the reader could recover.
    fn refuse_continuation(&self, rt: &mut TabRuntime, receipt: Option<(u64, DeliveryReceipt)>) {
        let Some((seq, receipt)) = receipt else { return };
        // Forgotten before the sender is told, so no answer outruns it.
        if let Err(error) = index::update_tab(&rt.session_id, &rt.tab_id, |t| {
            if t.continuation == Some(seq) { t.continuation = None; }
            Ok(())
        }) {
            log::warn!("forget the refused continuation of {}: {error:#}", rt.key());
        }
        let _ = receipt.send(Err("The sender's access changed before the handoff was delivered, so nothing was sent.".into()));
    }

    /// Decide whether to type after readiness has settled. A quiet-screen
    /// timeout says nothing about delivery: send normally and let transcript,
    /// hooks and terminal activity inform the single recovery banner.
    fn prepare_prompt(&self, rt: &mut TabRuntime, readiness: Readiness, receipt: Option<&DeliveryReceipt>) -> bool {
        if let Readiness::Blocked(message) = readiness {
            log::warn!("[{}] the CLI is on a first-run screen: {message}", rt.key());
            rt.turn_open = false;
            if let Engine::Cli(cli) = &mut rt.engine {
                cli.awaiting_delivery = None;
                cli.delivery_sent_at = None;
                cli.accept_by = None;
                cli.nudge_by = None;
            }
            self.apply(rt, Payload::Error { message: message.to_string(), fatal: false, detail: None }, None);
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
    fn wait_ready(&self, pane: &str, ready: &tui::Ready, shared: Option<&(crate::local_sharing::WritePermit, String, String, u64)>, mobile: Option<&(crate::local_runtime::mobile::WritePermit, String, String, u64)>, stopped: impl Fn() -> bool) -> Readiness {
        let deadline = Instant::now() + tui::READY_TIMEOUT;
        let blocked = || {
            self.terminals.read_output(pane).and_then(|out| if ready.announces_start() {
                claude::pty::blocking_screen(&out)
            } else {
                codex::pty::blocking_screen(&out)
            })
        };
        loop {
            if self.delivery_revoked(shared, mobile) {
                return Readiness::Cancelled;
            }
            // Stopped while the CLI starts, as one restarted for a new
            // effort or mode does (#746): the turn ends now, not once the
            // CLI is up and has been given the prompt after all.
            if stopped() {
                return Readiness::Stopped;
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

    /// Whether whoever sent a prompt through a share or a phone may no longer
    /// write to the tab it was sent to. The host's own prompts never are.
    fn delivery_revoked(&self, shared: Option<&(crate::local_sharing::WritePermit, String, String, u64)>, mobile: Option<&(crate::local_runtime::mobile::WritePermit, String, String, u64)>) -> bool {
        if mobile.is_some_and(|(permit, session, tab, _)| !permit.valid() || permit.check_mode(session, tab).is_err()) {
            return true;
        }
        shared.is_some_and(|(permit, session, tab, _)| {
            self.sharing.lock().unwrap().sessions.get(session).is_none_or(|share| !share.permit_current(permit, tab, chrono::Utc::now().timestamp_millis()))
        })
    }

    /// Wait, before typing a prompt into `pane`, until its CLI's input box
    /// is empty (#722).
    ///
    /// The box can hold what the reader typed in the terminal view, or a
    /// prompt Claude Code put back there when it dropped a turn before
    /// answering it. Typing then would send that text and this prompt as one,
    /// so nothing is typed while it is there, however long that is: the
    /// chat says the message is waiting and why, and it goes in once the
    /// reader has sent or cleared what is in the box. Its echo does not age
    /// meanwhile, and the pane is let go of between looks, so an earlier
    /// prompt's Enter can still be written again; a later prompt still
    /// waits its turn behind this one.
    ///
    /// A box that cannot be seen is typed into: a CLI whose box this cannot
    /// read must not stop taking prompts. One that held something and is
    /// then hidden (a picker opened over it) is waited on. One that holds
    /// something only for a moment, a CLI still drawing it empty after
    /// taking the prompt before, is waited out without a word.
    ///
    /// Every message sent and not yet typed is said to be waiting, not only
    /// this one: those behind it in the pane's line cannot get to the box
    /// before it. A command the app types for itself is nobody's message and
    /// does not wait: the change is refused (`command_not_typed`). A stop the
    /// reader made since `stops` withdraws a prompt still waiting.
    #[allow(clippy::too_many_arguments)]
    fn wait_for_empty_input<'t>(
        &self,
        rt_arc: &Arc<Mutex<TabRuntime>>,
        pane: &str,
        seq: Option<u64>,
        stops: u64,
        ticket: &'t Ticket,
        held: &mut Option<MutexGuard<'t, ()>>,
        revoked: impl Fn() -> bool,
        stage: &dyn Fn(&str, serde_json::Value),
    ) -> InputWait {
        let (kind, ready) = match &rt_arc.lock().unwrap().engine {
            Engine::Cli(p) => (p.harness, p.ready.clone()),
            _ => return InputWait::Type("unseen"),
        };
        let reader = match kind {
            CliKind::Claude => claude::pty::composer,
            CliKind::Codex => codex::pty::composer,
        };
        // When the box was first seen holding something, and whether the
        // prompt has been said to be waiting on it since.
        let mut held_since: Option<Instant> = None;
        let mut waiting = false;
        let outcome = loop {
            match self.terminals.screen(pane, reader).unwrap_or(tui::Composer::Unseen) {
                tui::Composer::Empty => break InputWait::Type(if held_since.is_some() { "cleared" } else { "empty" }),
                tui::Composer::Unseen if held_since.is_none() => break InputWait::Type("unseen"),
                tui::Composer::Unseen => {}
                screen @ (tui::Composer::Holds(_) | tui::Composer::Choice) => {
                    let choice = matches!(screen, tui::Composer::Choice);
                    let since = *held_since.get_or_insert_with(Instant::now);
                    if waiting {
                        self.input_reason(&mut rt_arc.lock().unwrap(), choice);
                    } else if since.elapsed() >= tui::INPUT_SETTLE {
                        // How much, never what: the diagnostics hold no prompt text.
                        let chars = match &screen {
                            tui::Composer::Holds(held_text) => held_text.chars().count(),
                            _ => 0,
                        };
                        stage("input_occupied", serde_json::json!({ "chars": chars, "choice": choice }));
                        if seq.is_none() {
                            break InputWait::Refused;
                        }
                        waiting = true;
                        self.input_waits(&mut rt_arc.lock().unwrap(), seq, choice);
                    }
                }
            }
            if revoked() {
                break InputWait::Revoked;
            }
            {
                let mut rt = rt_arc.lock().unwrap();
                let same = matches!(&rt.engine, Engine::Cli(p) if Arc::ptr_eq(&p.ready, &ready));
                if !same || !self.terminals.is_running(pane) || self.left_the_terminal(&rt).is_some() {
                    break InputWait::Gone;
                }
                if waiting && matches!(&rt.engine, Engine::Cli(p) if p.input.stops != stops) {
                    break InputWait::Withdrawn;
                }
                if let (Some(seq), Engine::Cli(p)) = (seq, &mut rt.engine) {
                    if let Some(echo) = p.echoed.iter_mut().find(|echo| echo.seq == seq) {
                        echo.sent_at = Instant::now();
                    }
                }
            }
            *held = None;
            std::thread::sleep(tui::INPUT_POLL);
            *held = Some(ticket.take());
        };
        if waiting {
            let withdrawn = matches!(outcome, InputWait::Withdrawn).then_some(seq).flatten();
            self.input_free(&mut rt_arc.lock().unwrap(), withdrawn);
        }
        outcome
    }

    /// A delivery is waiting on what the CLI's input box holds: the chat is
    /// told so of the message published under `seq`, and of every message
    /// sent and not yet typed behind it. A message sent to an idle CLI has
    /// the tab waiting on the reader meanwhile, not working.
    fn input_waits(&self, rt: &mut TabRuntime, seq: Option<u64>, choice: bool) {
        let Engine::Cli(p) = &mut rt.engine else { return };
        p.input.waiting = true;
        p.input.choice = choice;
        let untyped = p.echoed.iter().filter(|echo| !echo.submitted && !echo.command).map(|echo| echo.seq);
        let mut fresh: Vec<u64> = Vec::new();
        for seq in seq.into_iter().chain(untyped) {
            if !p.input.marks.contains(&seq) && !fresh.contains(&seq) {
                fresh.push(seq);
            }
        }
        p.input.marks.extend(&fresh);
        for prompt_seq in fresh {
            self.publish(rt, Payload::InputOccupied { prompt_seq, occupied: true, choice }, None);
        }
        self.wait_on_reader_for_input(rt);
    }

    /// What the waiting messages wait on changed while they wait: the reader
    /// answered the CLI's question and text is left in the box, or the other
    /// way round. The chat is told again, so it says what is in the way.
    fn input_reason(&self, rt: &mut TabRuntime, choice: bool) {
        let Engine::Cli(p) = &mut rt.engine else { return };
        if p.input.choice == choice {
            return;
        }
        p.input.choice = choice;
        let marks = p.input.marks.clone();
        for prompt_seq in marks {
            self.publish(rt, Payload::InputOccupied { prompt_seq, occupied: true, choice }, None);
        }
    }

    /// The tab waits on the reader while the message it was to start on is
    /// waiting on the input box.
    fn wait_on_reader_for_input(&self, rt: &mut TabRuntime) {
        let Engine::Cli(p) = &mut rt.engine else { return };
        let awaited = p.awaiting_delivery.is_some_and(|seq| p.input.marks.contains(&seq));
        if awaited && !p.input.made_waiting {
            p.input.made_waiting = true;
            self.set_status(rt, TabStatus::Waiting);
        }
    }

    /// The wait on the input box is over: none of the messages it held up is
    /// waiting on it any more, save `withdrawn`, which says so itself.
    fn input_free(&self, rt: &mut TabRuntime, withdrawn: Option<u64>) {
        let Engine::Cli(p) = &mut rt.engine else { return };
        p.input.waiting = false;
        p.input.choice = false;
        let marks = std::mem::take(&mut p.input.marks);
        let made_waiting = std::mem::take(&mut p.input.made_waiting);
        for prompt_seq in marks.into_iter().filter(|seq| Some(*seq) != withdrawn) {
            self.publish(rt, Payload::InputOccupied { prompt_seq, occupied: false, choice: false }, None);
        }
        if made_waiting && rt.status == TabStatus::Waiting && rt.recovery.is_none() && rt.pending.is_empty() {
            self.set_status(rt, if rt.turn_open { TabStatus::InProgress } else { TabStatus::Idle });
        }
    }

    /// A message the reader stopped the turn on before it was entered: while
    /// it waited on the input box (#722), on a CLI still starting, or while
    /// it was being typed (#746). It is not sent, and never will be. The chat
    /// says so and offers to send it again; a turn it was to start ends here,
    /// as stopped. A handoff's sender is told it did not go.
    fn prompt_withdrawn(&self, rt: &mut TabRuntime, seq: u64, receipt: Option<DeliveryReceipt>) {
        self.cancel_shared_prompt(rt, seq);
        if let Engine::Cli(p) = &mut rt.engine {
            forget_taken(p);
        }
        self.publish(rt, Payload::PromptWithdrawn { prompt_seq: seq, unconfirmed: false }, None);
        if let Some(receipt) = receipt {
            let _ = receipt.send(Err("The new session opened, but the handoff was stopped before its agent took it. The prepared prompt is retained.".into()));
        }
    }

    /// A command the app typed for itself (`/model`, `/effort`) that was not
    /// typed: the CLI's input box held something, or the reader stopped the
    /// turn while it did. The change is refused with the reason, rather than
    /// left to be typed whenever the box empties, after the tab has given up
    /// on it.
    fn command_not_typed(&self, rt: &mut TabRuntime, command: &str) {
        if let Engine::Cli(p) = &mut rt.engine {
            if let Some(at) = p.echoed.iter().position(|echo| echo.command && echo.text == command) {
                p.echoed.remove(at);
            }
            p.settings_asked_at = None;
        }
        let mut words = command.split_whitespace();
        let setting = match words.next() {
            Some("/model") => Setting::Model,
            Some("/effort") => Setting::Effort,
            _ => return,
        };
        let value = words.next();
        let agent = agent_name(&rt.harness);
        let why = format!("{agent}'s input box had text in it, so the change was not typed. Send or clear that text in its terminal, then choose again");
        if let Err(error) = self.refuse_setting(rt, setting, value, &why) {
            log::warn!("refuse an untyped {} change: {error:#}", setting.noun());
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
        let collaboration = collaboration_v2::current();
        let ready = collaboration.as_ref().map(|_| p.ready.clone());
        self.type_prompt(rt_arc, &p.pane_id, command, Vec::new(), PromptDelivery { collaboration, ready, stops: p.input.stops, ..Default::default() });
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
        self.on_hook_pumping(frame, |rt, tail| self.pump(rt, tail))
    }

    // Keep the transcript wait outside runtime; every later mutation must revalidate.
    fn on_hook_pumping(&self, frame: HookFrame, pump: impl FnOnce(&Arc<Mutex<TabRuntime>>, &Arc<tui::Tail>)) -> HookReply {
        // Every refusal says why, both here and back to the hook: a CLI whose
        // frames go unheard is a chat that never shows its reply (#202).
        let refuse = |reason: String| {
            log::warn!("hook {} for {}/{} refused by pid {} at {}: {reason}", frame.event, frame.session, frame.tab, std::process::id(), self.control.socket.display());
            HookReply::refused(reason)
        };
        if matches!(frame.event.as_str(), "PreToolUse" | "PermissionRequest") && self.accepting_work().is_err() {
            return refuse("The runtime is stopping; no tool decision was admitted".into());
        }
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
        let mine = |rt: &TabRuntime| Self::has_tail(rt, &tail)
            && matches!(&rt.engine, Engine::Cli(p) if p.origin.accepts(&frame));
        // Direct terminal prompts also reach tool hooks. A resolver's
        // reservation prevents another managed agent from editing even if
        // its prompt did not go through the app's composer.
        if frame.event == "PreToolUse" && crate::issue_pipeline::admission::check(&frame.session, &frame.tab).is_err() {
            return reply_for(kind, "PreToolUse", Decision::Deny);
        }
        // A run's worker never pushes, merges or deploys, in any permission
        // mode: refused here as well as by the rules its agent was launched
        // with, which match a command by its first words only.
        if frame.event == "PreToolUse" {
            if let Some(reason) = crate::orchestration::guard::refusal(&frame.payload).filter(|_| index::get(&frame.session).is_ok_and(|session| crate::orchestration::guard::limited(&session))) {
                log::info!("run worker {}/{}: {reason}", frame.session, frame.tab);
                return HookReply { output: Some(crate::orchestration::guard::refusal_output(&reason)), refused: None };
            }
            // A verifier of a run's result reads it and changes nothing: an edit, and a shell
            // command not known to only read, is refused in every permission mode, whatever its
            // tab is switched to later.
            let call = crate::orchestration::guard::verifier_call(&frame.payload);
            if !matches!(call, crate::orchestration::guard::VerifierCall::Leave) && {
                let known = crate::orchestration::store::is_verifier(&frame.session, &frame.tab);
                // The session's entry is read only when the runs could not be.
                crate::orchestration::guard::reads_only(known, known.is_none().then(|| index::get(&frame.session).ok()).flatten().as_ref(), &frame.tab)
            } {
                // Under the gates every command TerminalX runs itself is under (PRO-330): the person
                // lets it run read-only commands unasked, and the provider's sandbox could not have
                // narrowed what this one reads. Otherwise it is refused, never handed to the agent's
                // shell: nobody is there to be asked.
                let transcript = frame.payload["transcript_path"].as_str();
                let call = crate::orchestration::guard::held(call, store::settings::load().agents.read_only_commands, |cwd| provider_may_restrict(kind, &frame.session, &frame.tab, cwd, transcript));
                match call {
                    crate::orchestration::guard::VerifierCall::Refuse(reason) => {
                        log::info!("run verifier {}/{}: {reason}", frame.session, frame.tab);
                        return HookReply { output: Some(crate::orchestration::guard::refusal_output(&reason)), refused: None };
                    }
                    // As an approved discovery command is: TerminalX runs the vetted programs and
                    // answers this `PreToolUse` hook with what they printed, in that hook's form.
                    crate::orchestration::guard::VerifierCall::Run(approved) => {
                        let approved = if permission_directory(kind, &frame.payload).is_some() { approved } else { approved.directory_was_reported() };
                        return self.run_discovery(&rt_arc, &frame, kind, &frame.payload["tool_input"], approved, Answering::Verifier);
                    }
                    crate::orchestration::guard::VerifierCall::Leave => unreachable!("left alone above"),
                }
            }
            // A session acting for a bot (PRO-478: its chats and what they started) is held to
            // the bot's access as it is now, on top of the mode `bots::chat` holds it to: the
            // frame showed this launch's token, so its session is its own.
            // A built-in duty's run (PRO-477) meets its allow-list first.
            let (acting_bot, builtin) = {
                let rt = rt_arc.lock().unwrap();
                (rt.acting_bot.clone(), rt.bot_builtin.clone())
            };
            match crate::bots::builtins::session_gate(builtin.as_ref(), acting_bot.as_deref(), &frame.payload) {
                crate::bots::access::Gate::Leave => {}
                crate::bots::access::Gate::Refuse(reason) => {
                    log::info!("bot session {}/{}: {reason}", frame.session, frame.tab);
                    return HookReply { output: Some(crate::orchestration::guard::refusal_output(&reason)), refused: None };
                }
                // Claude: the gate does not wait here, where Claude gives a hook 10 s. It answers
                // "ask", so Claude raises its own permission request, whose hook carries the card
                // (and the gate's reason, see `PermissionRequest` below) for as long as any card;
                // a lapsed card there leaves the question to Claude's prompt, never to its mode.
                // Codex parks on this hook as it does in Ask every time, and a reply with no
                // output (a lapsed card, a tab that moved on), which Codex reads as "go ahead",
                // is a refusal here.
                crate::bots::access::Gate::Ask(reason) => {
                    log::info!("bot session {}/{} asks: {reason}", frame.session, frame.tab);
                    let output = match kind {
                        CliKind::Claude => crate::bots::access::claude_ask(&reason),
                        CliKind::Codex => crate::bots::access::codex_answer(self.ask_permission_because(&rt_arc, &frame, kind, Some(reason)).output),
                    };
                    return HookReply { output: Some(output), refused: None };
                }
            }
        }
        if frame.event == "StatusLine" {
            if kind == CliKind::Claude && self.status.usage.ingest_claude(usage_account.as_deref(), &frame.payload) {
                self.emit_usage();
            }
            // The same frame names the model and effort in force, and the
            // CLI sends it again whenever either changes, from either side.
            if let Some(signal) = (kind == CliKind::Claude).then(|| claude::transcript::status_settings(&frame.payload)).flatten() {
                let mut rt = rt_arc.lock().unwrap();
                if !mine(&rt) { return HookReply::default(); }
                if let Engine::Cli(p) = &mut rt.engine {
                    p.status_names_model |= matches!(&signal, Signal::Current { model: Some(_), .. });
                }
                self.provider_settings(&mut rt, signal);
            }
            return HookReply::default();
        }
        // Claude Code names its permission mode on the frames that fire
        // around work, which is the first the app hears of a Shift+Tab in the
        // terminal: read before anything this frame is about is drawn.
        if let Some(signal) = (kind == CliKind::Claude).then(|| claude::transcript::hook_permissions(&frame.payload)).flatten() {
            {
                let mut rt = rt_arc.lock().unwrap();
                if !mine(&rt) { return HookReply::default(); }
                self.provider_settings(&mut rt, signal);
            }
            if self.judge_reported_mode(&rt_arc, &tail) {
                return HookReply::default();
            }
        }
        // Stop at hook receipt, before transcript settling/git snapshots, so
        // time spent waiting for display bookkeeping is not agent work.
        if matches!(frame.event.as_str(), "Stop" | "SessionEnd") {
            let rt = rt_arc.lock().unwrap();
            if !mine(&rt) { return HookReply::default(); }
            self.record_activity(&rt, TabStatus::Completed, store::activity::Source::Live);
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
        let named = {
            let mut rt = rt_arc.lock().unwrap();
            if !mine(&rt) { return HookReply::default(); }
            match &mut rt.engine {
                Engine::Cli(p) => p.origin.transcript(&frame),
                _ => None,
            }
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
        pump(&rt_arc, &tail);

        // Claude Code fires `UserPromptSubmit` for the turns it starts itself
        // too (#540), and says so. Those carry nothing the reader sent.
        let source = match (kind, frame.event.as_str()) {
            (CliKind::Claude, "UserPromptSubmit") => claude::transcript::prompt_source(&frame.payload),
            _ => claude::transcript::PromptSource::Reader,
        };

        // Codex creates its session on the first prompt; Claude announces
        // startup before accepting input, so its SessionStart proves less.
        if (matches!(frame.event.as_str(), "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop") && source == claude::transcript::PromptSource::Reader)
            || (kind == CliKind::Codex && frame.event == "SessionStart") {
            let mut rt = rt_arc.lock().unwrap();
            if !mine(&rt) { return HookReply::default(); }
            self.delivery_confirmed(&mut rt);
        }

        // A chat links itself to the repo its agent just worked in. Off the
        // hook's thread: git answers fast, but the CLI is waiting on this reply.
        if frame.event == "PostToolUse" {
            let (sink, session, payload) = (self.sink.clone(), frame.session.clone(), frame.payload.clone());
            std::thread::spawn(move || match crate::chat_link::follow(&session, &payload) {
                Ok(Some(entry)) => sink.emit("session_updated", &entry),
                Ok(None) => {}
                Err(error) => log::warn!("link chat {session}: {error:#}"),
            });
        }

        let mut reply = HookReply::default();
        match frame.event.as_str() {
            // The CLI's session is up; the composer may stop waiting. Codex
            // also mints its own conversation id, so this is where the app
            // learns which one to resume next time.
            "SessionStart" => {
                {
                    let rt = rt_arc.lock().unwrap();
                    if !mine(&rt) { return HookReply::default(); }
                    if let Engine::Cli(p) = &rt.engine {
                        p.ready.mark();
                        // Codex runs this hook only once a prompt has made a
                        // session, past its own account check: the grant it
                        // was given is accepted. Claude Code runs it before
                        // asking its provider anything, which proves nothing.
                        if !p.ready.announces_start() {
                            crate::cloud_grants::launch_worked(&rt.launch_key());
                        }
                    }
                }
                if kind == CliKind::Codex {
                    if let Some(id) = frame.payload["session_id"].as_str() {
                        self.record_provider_session(&rt_arc, &tail, id);
                    }
                }
            }
            // The cloud browser for agents (PRO-209): its MCP server's calls.
            crate::cloud_browser::HOOK_EVENT => return self.cloud_browser_hook(&rt_arc, &frame, kind),
            // Its tools decide their own approval, once per browser session.
            "PermissionRequest" | "PreToolUse" if frame.payload["tool_name"].as_str().is_some_and(crate::cloud_browser::is_tool) => {
                return reply_for(kind, &frame.event, Decision::Allow);
            }
            "PermissionRequest" => {
                // A bot's gate (PRO-478): what it refuses is refused here too, saying why, and
                // what it asks about is asked on a card that says why.
                let (acting_bot, builtin) = {
                    let rt = rt_arc.lock().unwrap();
                    (rt.acting_bot.clone(), rt.bot_builtin.clone())
                };
                let because = match crate::bots::builtins::session_gate(builtin.as_ref(), acting_bot.as_deref(), &frame.payload) {
                    crate::bots::access::Gate::Refuse(reason) => {
                        log::info!("bot session {}/{}: {reason}", frame.session, frame.tab);
                        return HookReply { output: Some(crate::bots::access::permission_refusal(&reason)), refused: None };
                    }
                    crate::bots::access::Gate::Ask(reason) => Some(reason),
                    crate::bots::access::Gate::Leave => None,
                };
                return self.ask_permission_because(&rt_arc, &frame, kind, because);
            }
            // Codex asks twice about one escalating command: once here for
            // every tool, and again as a `PermissionRequest` when the sandbox
            // stops it. The reader answers once.
            "PreToolUse" if asks_every_tool => return self.ask_permission(&rt_arc, &frame, kind),
            // An event the CLI is only being offered: no turn has started.
            "UserPromptSubmit" if source == claude::transcript::PromptSource::Enqueued => {}
            "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => {
                let mut rt = rt_arc.lock().unwrap();
                // A settings restart/teardown may have replaced this launch
                // while its transcript was being drained above.
                if !mine(&rt) { return HookReply::default(); }
                if frame.event == "PreToolUse" && rt.stopping {
                    return refuse("The worker is stopping; no tool decision was admitted".into());
                }
                if frame.event == "UserPromptSubmit" && source == claude::transcript::PromptSource::Reader {
                    if let Engine::Cli(p) = &mut rt.engine {
                        for echo in p.echoed.iter_mut().filter(|echo| echo.submitted && !echo.queued && !echo.command) {
                            // A timed-out receipt must not absorb a later
                            // submission's hook. Keep its echo for deduplication.
                            if echo.confirm_delivery() { break; }
                        }
                    }
                }
                rt.last_activity = Instant::now();
                if frame.event == "UserPromptSubmit" {
                    // A slash command the CLI runs on a schedule is work, not
                    // a command typed at it that may never end.
                    let command = source == claude::transcript::PromptSource::Reader && frame.payload["prompt"].as_str().is_some_and(tui::is_slash_command);
                    rt.prompt_taken(if command { frame.payload["prompt"].as_str().unwrap_or("") } else { "" }, "hook_user_prompt_submit");
                } else {
                    if !rt.turn_open {
                        rt.open_turn();
                        rt.turn_opener = Some(("hook", if frame.event == "PreToolUse" { "pre_tool_use" } else { "post_tool_use" }));
                        rt.turn_started_at = Some(Instant::now());
                    }
                    // A tool running is work: the turn is not a bare command's.
                    rt.turn_by_command = false;
                }
                if rt.pending.is_empty() {
                    self.record_activity(&rt, TabStatus::InProgress, store::activity::Source::Live);
                    self.set_status(&mut rt, TabStatus::InProgress);
                }
                if frame.event == "UserPromptSubmit" {
                    // Prompts typed directly into a CLI bypass send_admitted. Its blocking
                    // hook can deliver pending revert context before the model sees them.
                    // A composer send already carries the note and owns this lock until admitted.
                    let send_lock = crate::checkpoints::send_lock(&frame.session, &frame.tab);
                    if let Ok(_sending) = send_lock.try_lock() {
                        match crate::checkpoints::pending(&frame.session, &frame.tab) {
                            Ok(notes) if !notes.is_empty() => {
                                reply.output = Some(serde_json::json!({ "hookSpecificOutput": {
                                    "hookEventName": "UserPromptSubmit",
                                    "additionalContext": crate::checkpoints::context(&notes),
                                }}));
                                if let Err(error) = crate::checkpoints::acknowledge(&frame.session, &frame.tab, &notes) {
                                    log::warn!("acknowledge CLI revert context: {error:#}");
                                }
                            }
                            Err(error) => log::warn!("read CLI revert context: {error:#}"),
                            _ => {}
                        }
                    };
                }
                if frame.event == "PreToolUse" {
                    // This authenticated, still-current launch only reported a
                    // tool. Explicitly acknowledge it: the local-owner bridge
                    // treats missing output as a failed decision and denies.
                    // An empty object leaves the provider's own approval and
                    // sandbox policy in charge; it is not an explicit allow.
                    reply.output = Some(serde_json::json!({}));
                }
                drop(rt);
                if frame.event == "UserPromptSubmit" {
                    self.observer.automation_running(&frame.session, &frame.tab);
                    // Typed into the CLI's own terminal, a prompt reaches
                    // nothing but this hook. One the CLI started itself is no answer.
                    if source == claude::transcript::PromptSource::Reader {
                        self.observer.answered(&frame.session, &frame.tab);
                    }
                }
                if kind == CliKind::Codex && frame.event == "PreToolUse" {
                    // This authenticated launch's mode does not ask our UI
                    // about every tool. Explicitly acknowledge no added hook
                    // decision: None is a lost decision to the local-owner
                    // bridge and must continue to fail closed. `{}` preserves
                    // the CLI's own sandbox/rules; it is not an Allow decision.
                    return HookReply { output: Some(serde_json::json!({})), refused: None };
                }
            }
            // The CLI is asking in its own TUI, which means our permission
            // hook did not answer in time. The reader has to go and look.
            "Notification" if frame.payload["notification_type"] == "permission_prompt" => {
                let mut rt = rt_arc.lock().unwrap();
                if !mine(&rt) { return HookReply::default(); }
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
                if !mine(&rt) { return HookReply::default(); }
                rt.last_activity = Instant::now();
                if rt.turn_open {
                    let completed = (rt.turn_generation, rt.turn_started_at, chrono::Utc::now());
                    self.close_open_turn(&mut rt, TurnStatus::Ok, final_text.clone());
                    self.after_turn_completed(&rt_arc, rt, final_text, completed);
                    return HookReply::default();
                }
            }
            // Codex only: the reader pressed Escape in the TUI.
            "Interrupt" => {
                let mut rt = rt_arc.lock().unwrap();
                if !mine(&rt) { return HookReply::default(); }
                if let Engine::Cli(p) = &mut rt.engine {
                    if p.codex_interrupt_hooks_owed > 0 {
                        p.codex_interrupt_hooks_owed -= 1;
                        // The transcript closed the interrupted turn already.
                        // Its continuation may now be running or asking us.
                        if !rt.turn_open {
                            self.record_activity(&rt, TabStatus::Completed, store::activity::Source::Live);
                            drop(rt);
                            self.observer.automation_failed(&frame.session, &frame.tab, "The automation turn was interrupted.");
                        }
                        return HookReply::default();
                    }
                }
                self.record_activity(&rt, TabStatus::Completed, store::activity::Source::Live);
                self.close_open_turn(&mut rt, TurnStatus::Aborted, None);
                drop(rt);
                self.observer.automation_failed(&frame.session, &frame.tab, "The automation turn was interrupted.");
            }
            // `/clear` (#1498): Claude Code ends its session to start a new
            // one. The turn the composer opened for the command is a command
            // that ran, not an interrupted one, and an automation that sent it
            // has completed.
            "SessionEnd" if frame.payload["reason"].as_str() == Some("clear") => {
                let mut rt = rt_arc.lock().unwrap();
                if !mine(&rt) { return HookReply::default(); }
                if rt.turn_open {
                    let completed = (rt.turn_generation, rt.turn_started_at, chrono::Utc::now());
                    self.end_open_turn(&mut rt, TurnStatus::Ok, None);
                    self.after_turn_completed(&rt_arc, rt, None, completed);
                    return HookReply::default();
                }
                self.set_status(&mut rt, TabStatus::Idle);
            }
            "SessionEnd" => {
                let mut rt = rt_arc.lock().unwrap();
                if !mine(&rt) { return HookReply::default(); }
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
                } else {
                    self.observer.automation_execution_lost(&frame.session, &frame.tab, "The agent session ended before the automation run completed.");
                }
            }
            _ => {}
        }
        self.restart_if_due(&rt_arc, &frame.session, &frame.tab, Some(&tail));
        reply
    }

    /// Finish a Stop hook or a watcher-closed turn. Release the tab lock
    /// before notifying automation or scheduling a settings restart that may
    /// re-enter the tab.
    fn after_turn_completed(&self, rt_arc: &Arc<Mutex<TabRuntime>>, mut rt: MutexGuard<'_, TabRuntime>, final_message: Option<String>, completed: (u64, Option<Instant>, chrono::DateTime<chrono::Utc>)) {
        let (session, tab) = (rt.session_id.clone(), rt.tab_id.clone());
        let (generation, started_at, finished) = completed;
        let tail = match &rt.engine { Engine::Cli(p) => Some(p.tail.clone()), _ => None };
        let started = started_at.and_then(|at| chrono::TimeDelta::from_std(at.elapsed()).ok()).map(|elapsed| chrono::Utc::now() - elapsed);
        let watch = rt.background.clone();
        rt.automation_completions_in_flight += 1;
        let completion = AutomationCompletionGuard(rt_arc.clone());
        drop(rt);
        if let Some(watch) = watch { watch.lock().unwrap().automation_turn_completed(started, finished, final_message.as_deref()); }
        self.observer.automation_completed(&session, &tab, final_message, generation);
        drop(completion);
        self.restart_if_due(rt_arc, &session, &tab, tail.as_deref());
    }

    /// A setting the CLI only reads at startup changed mid-turn: the restart
    /// it needs waits here, until the turn it would have interrupted is over.
    /// Off this thread, so the hook's reply reaches the CLI before the CLI is
    /// replaced.
    fn restart_if_due(&self, rt_arc: &Arc<Mutex<TabRuntime>>, session_id: &str, tab_id: &str, tail: Option<&tui::Tail>) {
        let expected = {
            let rt = rt_arc.lock().unwrap();
            if rt.stopping || tail.is_some_and(|tail| !Self::has_tail(&rt, tail)) { return; }
            match &rt.engine {
                Engine::Cli(p) if p.restart_when_idle && !rt.turn_open => p.tail.clone(),
                _ => return,
            }
        };
        let (manager, rt_arc, session, tab) = (self.clone(), rt_arc.clone(), session_id.to_string(), tab_id.to_string());
        std::thread::spawn(move || {
            if let Some(work) = manager.begin_idle_restart_launch(&rt_arc, &expected) {
                if let Err(e) = manager.complete_cli_restart(&rt_arc, work) {
                    log::warn!("restart {session}/{tab}: {e:#}");
                }
            }
        });
    }

    fn record_provider_session(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>, id: &str) {
        let (rt_arc, tail, id) = (rt_arc.clone(), tail.clone(), id.to_string());
        std::thread::spawn(move || Self::persist_provider_session(&rt_arc, &tail, id));
    }

    fn persist_provider_session(rt_arc: &Arc<Mutex<TabRuntime>>, tail: &tui::Tail, id: String) {
        // The worker can be scheduled after teardown. Keep validation and
        // persistence together so it cannot overwrite a successor's id.
        // This follows runtime -> index transaction order; the writer closure
        // only edits the index value and never reacquires runtime.
        let rt = rt_arc.lock().unwrap();
        if !Self::has_tail(&rt, tail) { return; }
        let _ = index::update_tab(&rt.session_id, &rt.tab_id, |t| {
            if t.provider_session_id.as_deref() != Some(&id) {
                t.provider_session_id = Some(id);
            }
            Ok(())
        });
    }

    /// Turn a permission hook into the chat's own card and wait for it to be
    /// answered. The hook thread parks here, which is exactly what holds the
    /// CLI's tool call up until the reader decides.
    fn ask_permission(&self, rt_arc: &Arc<Mutex<TabRuntime>>, frame: &HookFrame, kind: CliKind) -> HookReply {
        self.ask_permission_because(rt_arc, frame, kind, None)
    }

    /// [`Self::ask_permission`], with `because` as why the card is up when the
    /// app itself is the one asking (a bot's outward call, PRO-478).
    /// A cloud browser tool call from this tab's agent (PRO-209). A tab that
    /// asks first shows one card when a browser session opens.
    fn cloud_browser_hook(&self, rt_arc: &Arc<Mutex<TabRuntime>>, frame: &HookFrame, kind: CliKind) -> HookReply {
        let (mode, key) = {
            let rt = rt_arc.lock().unwrap();
            let Engine::Cli(p) = &rt.engine else { return HookReply::default() };
            if !p.origin.accepts(frame) { return HookReply::default(); }
            (p.mode.clone(), format!("{}/{}", rt.session_id, rt.tab_id))
        };
        let tab_title = index::get(&frame.session).ok().and_then(|entry| entry.tab(&frame.tab).and_then(|tab| tab.title.clone()));
        let agent = match kind {
            CliKind::Claude => "Claude Code",
            CliKind::Codex => "Codex",
        };
        let approve = |input: Value| self.ask_cloud_browser(rt_arc, frame, kind, input);
        let caller = crate::cloud_browser::Caller { key, agent, tab_title, asks: !crate::cloud_browser::runs_without_asking(&mode) };
        HookReply { output: Some(crate::cloud_browser::call(caller, &frame.payload, &approve)), refused: None }
    }

    /// The browser session's one card: allowed or not.
    fn ask_cloud_browser(&self, rt_arc: &Arc<Mutex<TabRuntime>>, frame: &HookFrame, kind: CliKind, input: Value) -> bool {
        let gate = "PermissionRequest";
        let request_id = uuid::Uuid::now_v7().to_string();
        let tool_name = crate::cloud_browser::OPEN_TOOL.to_string();
        let (tx, rx) = std::sync::mpsc::channel::<QueuedDecision>();
        {
            let mut rt = rt_arc.lock().unwrap();
            let Engine::Cli(p) = &mut rt.engine else { return false };
            if !p.origin.accepts(frame) { return false; }
            p.decisions.insert(request_id.clone(), DecisionSender {
                sender: tx,
                caller: crate::hooks::Caller::default(),
                gate: gate.to_string(),
                session_command: None,
            });
            let options = claude::mapper::build_options(&[]).into_iter().map(|option| match option.kind {
                crate::events::PermissionOptionKind::AllowOnce => crate::events::PermissionOption { label: "Allow for this browser session".into(), ..option },
                _ => option,
            }).collect();
            let payload = Payload::PermissionRequested {
                request_id: request_id.clone(),
                tool_use_id: String::new(),
                title: Some("Use the browser on the cloud desktop?".into()),
                description: input["plan"].as_str().filter(|plan| !plan.trim().is_empty()).map(String::from),
                reason: None,
                cwd: None,
                options,
                tool_name: tool_name.clone(),
                input: input.clone(),
            };
            rt.pending.insert(request_id.clone(), PendingAsk { tool_use_id: String::new(), tool_name, input, suggestions: Vec::new() });
            self.apply(&mut rt, payload, None);
        }
        let waiting = Waiting { kind, gate: gate.to_string(), request_id, local_owner: false };
        let reply = self.await_decision(rt_arc, waiting, rx, |rt| matches!(&rt.engine, Engine::Cli(p) if p.origin.accepts(frame)));
        reply.output.as_ref().is_some_and(|output| output["hookSpecificOutput"]["decision"]["behavior"] == "allow")
    }

    fn ask_permission_because(&self, rt_arc: &Arc<Mutex<TabRuntime>>, frame: &HookFrame, kind: CliKind, because: Option<String>) -> HookReply {
        let local_owner = crate::local_runtime::permissions::enabled();
        let _waiter = if local_owner {
            match crate::local_runtime::permissions::Permit::acquire() {
                Some(permit) => Some(permit),
                None => return reply_for(kind, &frame.event, Decision::Deny),
            }
        } else { None };
        let request_id = uuid::Uuid::now_v7().to_string();
        let tool_name = frame.payload["tool_name"].as_str().unwrap_or("tool").to_string();
        let input = frame.payload["tool_input"].clone();
        let suggestions: Vec<Value> = frame.payload["permission_suggestions"].as_array().cloned().unwrap_or_default();
        let gate = frame.event.as_str();

        // Every hook that asks is asked on its own card, whichever gate it is
        // and whatever was answered before: Codex's sandbox asking at
        // `PermissionRequest` after the reader allowed the command at
        // `PreToolUse` wants more than the reader granted (PRO-160).
        //
        // An automatic discovery allowance only skips TerminalX's Ask gate.
        // Codex's own PermissionRequest (sandbox/network escalation), and
        // Claude's safety checks in bypass mode, always remain a decision.
        // TerminalX runs such a command itself, outside the provider's
        // sandbox (PRO-330), so it is automatic only while that sandbox could
        // not have narrowed what the command reads; otherwise it is asked.
        let verified_cwd = permission_directory(kind, &frame.payload);
        let cwd = verified_cwd.or_else(|| {
            (kind == CliKind::Codex && crate::harness::read_only::command(&tool_name, &input).is_some())
                .then(|| crate::harness::read_only::reported_scope(&input, frame.payload["cwd"].as_str())).flatten()
        });
        let (session_command, discovery) = {
            let rt = rt_arc.lock().unwrap();
            let Engine::Cli(p) = &rt.engine else { return HookReply::default() };
            if !p.origin.accepts(frame) { return HookReply::default(); }
            let mode = if kind == CliKind::Claude { frame.payload["permission_mode"].as_str().unwrap_or(&p.mode) } else { &p.mode };
            let ask_gate = codex::asks_every_tool(mode)
                && ((kind == CliKind::Codex && gate == "PreToolUse") || kind == CliKind::Claude);
            if ask_gate {
                let key = crate::harness::read_only::session_key(&tool_name, &input, cwd);
                let granted = key.as_ref().is_some_and(|key| self.session_commands.lock().unwrap()
                    .get(&rt.key()).is_some_and(|commands| commands.contains(key)));
                if granted {
                    // The grant covers this gate only: a subsequent provider
                    // escalation still needs its own approval card.
                    if let Some(updated) = key.as_deref().and_then(|key| crate::harness::read_only::session_input(&tool_name, &input, key)) {
                        return reply_for(kind, gate, Decision::Execute(updated));
                    }
                }
                let unconfined = || cwd.is_some_and(|cwd| !provider_may_restrict(kind, &rt.session_id, &rt.tab_id, Path::new(cwd), frame.payload["transcript_path"].as_str()));
                match (store::settings::load().agents.read_only_commands && unconfined())
                    .then(|| crate::harness::read_only::approved(&tool_name, &input, cwd)).flatten() {
                    Some(approved) => (None, Some(approved)),
                    None => (key, None),
                }
            } else { (None, None) }
        };
        if let Some(approved) = discovery {
            let approved = if verified_cwd.is_some() { approved } else { approved.directory_was_reported() };
            return self.run_discovery(rt_arc, frame, kind, &input, approved, Answering::Permission);
        }

        let (tx, rx) = std::sync::mpsc::channel::<QueuedDecision>();
        {
            let mut rt = rt_arc.lock().unwrap();
            let Engine::Cli(p) = &rt.engine else { return HookReply::default() };
            if !p.origin.accepts(frame) { return HookReply::default(); }
            // PRO-160: Codex's code-mode `exec` hands the turn back to the
            // model while a call inside it waits on its card, and the model
            // may run the same command again. Its repeat can reach either
            // gate while the first waits at either one: its `PreToolUse`
            // while the first waits to leave the sandbox, or its
            // `PermissionRequest` with the justification reworded. A second
            // card for it is the one a reader answers twice, and the command
            // then runs twice. Judged under the same lock that files a card,
            // so two hooks cannot both pass; the model is told why, and the
            // waiting call has the answer.
            let what = asked_to_run(&input);
            if kind == CliKind::Codex && rt.pending.iter().any(|(id, ask)| ask.tool_name == tool_name && p.decisions.contains_key(id) && asked_to_run(&ask.input) == what) {
                return HookReply { output: Some(codex::pty::already_waiting(gate)), refused: None };
            }
            let Engine::Cli(p) = &mut rt.engine else { unreachable!() };
            p.decisions.insert(request_id.clone(), DecisionSender {
                sender: tx,
                caller: if local_owner { crate::hooks::Caller::current() } else { crate::hooks::Caller::default() },
                gate: gate.to_string(),
                session_command: session_command.clone(),
            });
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
                    // The agent's words only: never invent a justification or
                    // change the tool input. Why the card is up is `reason`.
                    description: ["justification", "description"].iter()
                        .find_map(|field| input[*field].as_str().filter(|s| !s.trim().is_empty()))
                        .map(String::from),
                    // Codex's sandbox asking to be left is said as that (PRO-160);
                    // no session allowance is offered at that gate.
                    reason: if let Some(because) = because {
                        Some(because)
                    } else if kind == CliKind::Codex && gate != "PermissionRequest" && verified_cwd.is_none() && crate::harness::read_only::command(&tool_name, &input).is_some() {
                        Some(match cwd {
                            Some(scope) => format!("Session allowances are limited to {scope}. Commands executing in another directory are blocked and need a separate one-time approval."),
                            None => "Codex did not report a verifiable execution directory. Approval applies only to this invocation.".into(),
                        })
                    } else { asked_because(kind, gate, &frame.payload, &p.mode, &tool_name) },
                    cwd: frame.payload["cwd"].as_str().filter(|s| !s.trim().is_empty()).map(String::from),
                    options: {
                        let mut options = claude::mapper::build_options(&suggestions);
                        if session_command.is_some() {
                            options.insert(1, crate::events::PermissionOption {
                                id: crate::harness::read_only::SESSION_OPTION.into(),
                                label: "Allow for this session".into(),
                                kind: crate::events::PermissionOptionKind::AllowSession,
                            });
                        }
                        options
                    },
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
        let verifier_permission = gate == "PermissionRequest" && {
            let known = crate::orchestration::store::is_verifier(&frame.session, &frame.tab);
            crate::orchestration::guard::reads_only(known, known.is_none().then(|| index::get(&frame.session).ok()).flatten().as_ref(), &frame.tab)
        };
        let waiting = Waiting { kind, gate: gate.to_string(), request_id, local_owner };
        // Teardown or a settings restart may replace this CLI while the hook
        // waits. An answer for that old launch cannot start the new one's work.
        let mut reply = self.await_decision(rt_arc, waiting, rx, |rt| matches!(&rt.engine, Engine::Cli(p) if p.origin.accepts(frame)));
        // A provider permission refusal is separate from verifier policy and
        // from an executed command's nonzero exit. Preserve that distinction
        // in the hook answer the model receives, not just the chat's error row.
        if verifier_permission {
            if let Some(output) = reply.output.as_mut() {
                let decision = &mut output["hookSpecificOutput"]["decision"];
                if decision["behavior"] == "deny" {
                    let reason = decision["message"].as_str().unwrap_or("Permission denied.");
                    decision["message"] = serde_json::json!(format!("{reason} Provider permission was not granted for this verifier call; it did not run. Use Read, Grep or Glob on permitted worktree files, or judge the supplied diff. An allowance for one outside-worktree Read does not grant other tools or commands access."));
                }
            }
        }
        reply
    }

    /// TerminalX runs an approved discovery command's programs itself,
    /// outside the tab's lock, and answers with their result. The provider's
    /// shell has loaded the user's startup files, so it runs nothing
    /// (PRO-330). The run stops when nobody is left to read the result: the
    /// hook's connection closed (Esc, the CLI giving up) or the tab no
    /// longer has the CLI that asked. `answering` says which hook is answered,
    /// and so the form of the answer and what an unfinished run is told.
    fn run_discovery(&self, rt_arc: &Arc<Mutex<TabRuntime>>, frame: &HookFrame, kind: CliKind, input: &Value, approved: crate::harness::read_only::Approved, answering: Answering) -> HookReply {
        // No answer lets the agent run the command itself. That is right where a person is asked
        // next; a verifier is never to run one, so there the command is refused instead.
        let unanswered = || match answering {
            Answering::Verifier => HookReply { output: Some(crate::orchestration::guard::refusal_output(crate::orchestration::guard::STOPPED)), refused: None },
            Answering::Permission => HookReply::default(),
        };
        // Codex records no item for a call its hook answered, so the chat
        // would not show this command at all. Claude's transcript does.
        let row = (kind == CliKind::Codex).then(|| {
            let id = frame.payload["tool_use_id"].as_str().filter(|id| !id.is_empty()).map(String::from)
                .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
            format!("terminalx-ran-{id}")
        });
        let command = crate::harness::read_only::command(frame.payload["tool_name"].as_str().unwrap_or(""), input).unwrap_or("").to_string();
        if let Some(call_id) = &row {
            let mut rt = rt_arc.lock().unwrap();
            if !matches!(&rt.engine, Engine::Cli(p) if p.origin.accepts(frame)) { return unanswered(); }
            let title = format!("shell {}", command.lines().next().unwrap_or(""));
            self.apply(&mut rt, Payload::ToolCallStarted {
                call_id: call_id.clone(), name: "shell".into(), tool_type: ToolType::Shell,
                input: serde_json::json!({"command": command, "cwd": approved.directory().display().to_string()}),
                title: Some(title),
            }, None);
        }
        let caller = crate::hooks::Caller::current();
        let wanted = || caller.connected() && matches!(&rt_arc.lock().unwrap().engine, Engine::Cli(p) if p.origin.accepts(frame));
        let ran = approved.run_while(&wanted);
        if let Some(call_id) = row {
            let mut rt = rt_arc.lock().unwrap();
            if matches!(&rt.engine, Engine::Cli(p) if p.origin.accepts(frame)) {
                let result = match &ran {
                    Some(ran) => ToolResult { text: ran.output.clone(), is_error: ran.status != 0, exit_code: Some(ran.status), ..Default::default() },
                    None => ToolResult { text: "Stopped: the agent stopped waiting for this command.".into(), is_error: true, ..Default::default() },
                };
                self.apply(&mut rt, Payload::ToolCallCompleted { call_id, result }, None);
            }
        }
        let Some(ran) = ran else { return unanswered() };
        let mut report = ran.report();
        if ran.status != 0 {
            let at = report.find("\n\nOutput").unwrap_or(report.len());
            report.insert_str(at, "\nThis is the vetted executor's result, rather than a verifier policy refusal or provider permission denial. Search exit status 1 can mean no matches. Review the output; use Read, Grep or Glob on permitted files for another lookup.");
        }
        let output = match (kind, answering) {
            // The same `PreToolUse` denial carries the result for both agents. Claude Code
            // ignores an answer in another hook's form ("Hook returned incorrect event name").
            (CliKind::Codex, _) | (CliKind::Claude, Answering::Verifier) => codex::pty::pre_tool_ran(&report),
            (CliKind::Claude, Answering::Permission) => claude::pty::permission_ran(&report),
        };
        HookReply { output: Some(output), refused: None }
    }

    /// Wait for the decision on the card a permission hook asked for, and
    /// say it as that hook prints it, once `mine` finds the tab still has the
    /// CLI that asked. A frame handed over by the runtime this one replaced
    /// waits here too, for the card it asked for there (#765).
    fn await_decision(&self, rt_arc: &Arc<Mutex<TabRuntime>>, waiting: Waiting, rx: std::sync::mpsc::Receiver<QueuedDecision>, mine: impl Fn(&TabRuntime) -> bool) -> HookReply {
        let Waiting { kind, gate, request_id, local_owner } = waiting;
        let gate = gate.as_str();
        let wait = match kind {
            CliKind::Claude => claude::pty::PERMISSION_WAIT,
            CliKind::Codex => codex::pty::PERMISSION_WAIT,
        };
        // Waiting on a person, the frame is no work a handover waits for.
        let parked = crate::hooks::park(&request_id);
        let answer = if local_owner {
            crate::local_runtime::permissions::wait(rx, crate::local_runtime::permissions::WAIT, crate::hooks::caller_connected)
        } else { wait_for_decision(rx, wait) };
        #[cfg_attr(not(unix), allow(clippy::drop_non_drop))]
        drop(parked);
        let mut rt = rt_arc.lock().unwrap();
        if !mine(&rt) {
            if answer.is_some_and(|queued| queued.mobile.is_some()) { return reply_for(kind, gate, Decision::Deny); }
            return HookReply::default();
        }
        if let Engine::Cli(p) = &mut rt.engine {
            p.decisions.remove(&request_id);
        }
        match answer {
            Some(QueuedDecision { decision, mobile: Some(mobile) }) => {
                let Engine::Cli(cli) = &rt.engine else { return reply_for(kind, gate, Decision::Deny); };
                let (generation, token) = (cli.generation, cli.origin.token.clone());
                drop(rt);
                let denied = reply_for(kind, gate, Decision::Deny);
                let allow = !matches!(decision, Decision::Deny);
                let reply = reply_for(kind, gate, decision);
                let manager = self.clone();
                let runtime = rt_arc.clone();
                let MobileDecision { permit, label, session_command } = mobile;
                let deliver = move |write: &mut dyn FnMut(bool) -> bool| {
                    // Take the phone grant before the tab lock, as at admission. Keep
                    // both until the bounded write settles so cancellation and
                    // revocation cannot pass the last check before delivery.
                    let grant = permit.enter().ok();
                    let mut rt = runtime.lock().unwrap();
                    if !matches!(&rt.engine, Engine::Cli(cli) if cli.generation == generation && cli.origin.token == token)
                        || !rt.pending.contains_key(&request_id) {
                        drop(rt);
                        drop(grant);
                        write(false);
                        return;
                    }
                    let delivered = write(grant.is_some()) && grant.is_some();
                    let ask = rt.pending.remove(&request_id).expect("checked under tab lock");
                    if delivered && !session_command.is_empty() {
                        manager.session_commands.lock().unwrap().entry(rt.key()).or_default().insert(session_command);
                    }
                    manager.publish(&mut rt, Payload::PermissionDecided {
                        request_id, tool_use_id: Some(ask.tool_use_id), allowed: delivered && allow,
                        label: if delivered { label } else { "Cancelled".into() }, automatic: !delivered,
                    }, None);
                    if !delivered { return; }
                    if rt.pending.is_empty() {
                        manager.record_activity(&rt, TabStatus::InProgress, store::activity::Source::Live);
                        manager.set_status(&mut rt, TabStatus::InProgress);
                    }
                    let (session, tab) = (rt.session_id.clone(), rt.tab_id.clone());
                    drop(rt);
                    manager.observer.answered(&session, &tab);
                };
                if crate::hooks::guard_mobile_reply(denied.clone(), deliver) { reply } else { denied }
            }
            Some(QueuedDecision { decision, mobile: None }) => {
                if rt.pending.is_empty() {
                    self.record_activity(&rt, TabStatus::InProgress, store::activity::Source::Live);
                    self.set_status(&mut rt, TabStatus::InProgress);
                }
                reply_for(kind, gate, decision)
            }
            // Withdrawn with its turn (`cancel_asks`), which has said so in the
            // chat already: the tool is not run, and nothing has lapsed.
            None if !rt.pending.contains_key(&request_id) => reply_for(kind, gate, Decision::Deny),
            None if local_owner => {
                // A finite provider deadline or a lost hook transport is a
                // denial, never permission to continue through a default reply.
                self.apply(&mut rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Cancelled".into(), automatic: true }, None);
                if rt.pending.is_empty() {
                    let status = if rt.turn_open { TabStatus::InProgress } else { TabStatus::Idle };
                    self.record_activity(&rt, status, store::activity::Source::Live);
                    self.set_status(&mut rt, status);
                }
                reply_for(kind, gate, Decision::Deny)
            }
            None => {
                // The CLI has stopped waiting on us and will ask in its own
                // TUI; the card must stop offering buttons that go nowhere.
                self.apply(&mut rt, Payload::PermissionDecided { request_id, tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true }, None);
                self.needs_recovery(&mut rt, RecoveryKind::PermissionExpired, crate::recovery_log::Source::PermissionLapsed);
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
        self.refuse_codex_stdio_operation(session_id, tab_id)?;
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
            self.retire_provider(&rt);
            rt.turn_open = false;
            rt.queued.clear();
            self.with_provider_state(&rt, |state| state.queue.clear());
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

    #[cfg(all(test, unix))]
    fn on_line(&self, rt_arc: &Arc<Mutex<TabRuntime>>, line: &str) { self.on_line_from(rt_arc, line, None); }

    fn on_line_from(&self, rt_arc: &Arc<Mutex<TabRuntime>>, line: &str, epoch: Option<&std::sync::atomic::AtomicU64>) {
        let mut rt = rt_arc.lock().unwrap();
        if epoch.is_some_and(|epoch| rt.child.as_ref().is_none_or(|child| child.epoch != epoch.load(std::sync::atomic::Ordering::Acquire))) { return; }
        // OpenCode stdout is not its native event transport, and cannot
        // manufacture an original HTTP callback for a carried association.
        if self.carried_opencode(&rt) { return; }
        if rt.stopping && matches!(&rt.engine, Engine::Acp(_)) { return; }
        rt.last_activity = Instant::now();
        let _privacy = match self.prepare_acp_opening_settings(&mut rt) {
            Ok(privacy) => privacy,
            Err(error) => {
                rt.stopping = true;
                self.needs_recovery(&mut rt, RecoveryKind::Disconnected, crate::recovery_log::Source::Connection);
                self.publish(&mut rt, Payload::Status { text: format!("Could not read the agent's launch settings. Stop the agent before retrying: {error:#}"), handoff: None }, None);
                return;
            }
        };
        let actions = match &mut rt.engine {
            Engine::Acp(a) => a.handle(line),
            Engine::OpenCode(o) => o.handle(line),
            Engine::CodexStdio(_) | Engine::Cli(_) | Engine::None => return,
        };
        rt.incidents.progress("agent_output");
        self.stall_disproved(&mut rt);
        self.apply_actions(&mut rt, actions);
    }

    fn apply(&self, rt: &mut TabRuntime, payload: Payload, subagent: Option<SubagentRef>) {
        // A word about the provider's own settings is for the tab, not the log.
        let payload = match payload {
            Payload::ProviderSettings { signal } => {
                if subagent.is_none() {
                    self.provider_settings(rt, signal);
                }
                return;
            }
            other => other,
        };
        // Claude Code names the model that answered in each assistant record.
        // Its status line is the better word, and once that has spoken for
        // this launch it is the only one listened to: a record can name a
        // fallback the session is not set to.
        let unnamed_by_status = matches!(&rt.engine, Engine::Cli(p) if p.harness == CliKind::Claude && !p.status_names_model);
        if let (true, None, Payload::UsageUpdate(Usage { model: Some(model), .. })) = (unnamed_by_status, &subagent, &payload) {
            self.provider_settings(rt, Signal::Current { model: Some(model.clone()), effort: None });
        }
        if subagent.is_none() {
            // Before anything below reads it: a warning this progress takes
            // down is taken down by progress (#815).
            if let Some(kind) = crate::recovery_log::progress_of(&payload) { rt.incidents.progress(kind); }
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
                self.recovery_cleared(rt, "turn_ended");
            }
            if let Some(kind) = recovery::failure(&payload) {
                rt.signed_out_in_turn |= kind == RecoveryKind::SignedOut && rt.turn_open;
                self.needs_recovery(rt, kind, crate::recovery_log::source_of(&payload));
            }
            self.account_switch_observe(rt, &payload);
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
            Payload::TurnCompleted { status, final_text, usage, duration_ms, auth_failed, detail, .. } => {
                let head = None; // The publication path captures and pins the completed tree.
                // Occupancy as the turn left it, and the tab's token and cost
                // totals read again from its agent's transcript (PRO-273),
                // both off this thread: a long transcript takes a moment.
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
                if subagent.is_none() {
                    let sink = self.sink.clone();
                    crate::session_usage::schedule(&rt.session_id, &rt.tab_id, move |entry| sink.emit("session_updated", &entry));
                }
                let duration_ms = duration_ms.or_else(|| rt.turn_started_at.map(|t| t.elapsed().as_millis() as u64));
                let auth_failed = auth_failed || (subagent.is_none() && std::mem::take(&mut rt.signed_out_in_turn));
                Payload::TurnCompleted { status, final_text, usage, duration_ms, head, auth_failed, detail }
            }
            other => other,
        };
        let main = subagent.is_none();
        let sign_in_refused = main && matches!(&payload, Payload::TurnCompleted { auth_failed: true, .. });
        let worked = main && matches!(&payload, Payload::TurnCompleted { status: TurnStatus::Ok, auth_failed: false, .. });
        self.publish(rt, payload, subagent);
        if main && is_boundary {
            // Whether it moves to another account before its next prompt (#981).
            self.account_switch_after_turn(rt);
        }
        if sign_in_refused {
            // A reply drawn after the refusal may have taken the recovery back.
            if rt.recovery != Some(RecoveryKind::SignedOut) {
                self.needs_recovery(rt, RecoveryKind::SignedOut, crate::recovery_log::Source::SignIn);
            }
            self.sign_in_refused(rt);
        } else if worked {
            // A turn the provider answered: the grant it ran on is accepted.
            crate::cloud_grants::launch_worked(&rt.launch_key());
        }

        if is_boundary {
            rt.turn_open = false;
            if let Engine::Cli(p) = &mut rt.engine {
                p.awaiting_delivery = None;
                p.transcript_end_owed = !p.transcript_turn.take().is_some_and(tui::TurnMark::ends);
                // What the reader queued behind a stopped turn is still
                // expected (#427): interrupted with a message queued, both
                // CLIs send it at once as their next prompt (Claude Code
                // 2.1.296, Codex 0.153.4), and its record then starts the
                // next turn as that same message rather than a second copy
                // of it. One a CLI keeps in its input instead is flagged
                // after `QUEUED_ECHO_GRACE`, as behind a turn that finished.
                //
                // That wait starts here, where the turn ends. Counted from
                // when the message was sent, one queued behind a long, quiet
                // turn had run out of time before the CLI could take it: the
                // transcript says nothing while a reply streams, and a turn
                // stopped by its hook closes with nothing new to read.
                let now = Instant::now();
                for prompt in p.echoed.iter_mut() {
                    prompt.sent_at = now;
                }
            }
            // A stopped turn is not waiting for answers: an Escape pressed in
            // the agent's own terminal ends it with a card still open here.
            if aborted {
                self.cancel_asks(rt);
            }
            // An interrupted turn hands over to the next queued message like
            // one that finished (#427): Escape stops a turn, not the queue. A
            // hard stop has emptied the queue before it closes the turn.
            if self.drain_provider_queue(rt) { return; }
            self.set_status(rt, if rt.recovery.is_some() { TabStatus::Waiting } else if aborted { TabStatus::Idle } else { TabStatus::Completed });
            if main && (worked || (aborted && rt.held_queue.next.is_some())) { self.schedule_held(rt); }
        }
    }

    /// Queue admission is per item; the completing callback's TLS is never
    /// a source of authority. V2 physical routes remain refused below.
    fn drain_provider_queue(&self, rt: &mut TabRuntime) -> bool {
        if self.carried_acp(rt) || self.carried_opencode(rt) {
            let manager = self.clone(); let runtime = rt.me.clone();
            std::thread::spawn(move || { if let Some(runtime) = runtime.upgrade() { manager.drain_carried_acp_queue(&runtime); } });
            return !rt.queued.is_empty();
        }
        while !matches!(rt.engine, Engine::CodexStdio(_)) && !rt.stopping && rt.recovery.is_none() && !rt.queued.is_empty() {
            let pending = rt.queued.remove(0);
            let Some(binding) = self.provider_binding(rt) else {
                self.with_provider_state(rt, |state| state.queue.cancel(pending.seq, &pending.message.id));
                self.publish(rt, Payload::PromptWithdrawn { prompt_seq: pending.seq, unconfirmed: false }, None);
                continue;
            };
            let operation = self.with_provider_state(rt, |state| state.queue.take(pending.seq, &pending.message.id, pending.privacy.clone(), binding.clone()));
            let witness = Self::collaboration_witness(rt);
            let admitted = operation.try_dispatch(&binding, operation.correlation(), witness.as_ref(), |sender| {
                // V2 provider physical writers remain blocked, including restored
                // work. This check does not upgrade an unsupported Everyone witness.
                anyhow::ensure!(!sender.permit().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2()), "This engine has no collaboration-v2 final writer");
                anyhow::ensure!(sender.mobile.is_none() && sender.local_share.is_none(), "queued provider sender requires adapter integration");
                Ok(())
            }, || Ok(()));
            if matches!(admitted, Ok(provider_authority::Attempt::Deferred)) {
                // No mutation on contention. Preserve exact operation, sequence,
                // ID and sender rather than relabel it with this callback's TLS.
                let policy = operation.sender().permit().cloned();
                let manager = self.clone();
                let runtime = rt.me.clone();
                self.with_provider_state(rt, |state| state.queue.reinsert(pending.seq, pending.message.id.clone(), operation));
                rt.queued.insert(0, pending);
                std::thread::spawn(move || {
                    // Wait with no runtime/session/sender guards. This is only a
                    // wakeup: drop admission and recheck the ORIGINAL operation
                    // in drain_provider_queue, never carry a ready token forward.
                    { let _policy = policy.as_ref().map(|permit| permit.collaboration.enter_admission()); }
                    let Some(runtime) = runtime.upgrade() else { return };
                    let mut rt = runtime.lock().unwrap();
                    if !rt.turn_open { manager.drain_provider_queue(&mut rt); }
                });
                break;
            }
            if !matches!(admitted, Ok(provider_authority::Attempt::Applied)) {
                self.publish(rt, Payload::PromptWithdrawn { prompt_seq: pending.seq, unconfirmed: false }, None);
                continue;
            }
            let sender = operation.sender();
            let Ok(_privacy) = crate::data_privacy::delivery_scope(sender.privacy.as_ref()) else {
                operation.withdraw();
                self.publish(rt, Payload::PromptWithdrawn { prompt_seq: pending.seq, unconfirmed: false }, None);
                continue;
            };
            let q = pending.message;
            let delivery = Some(acp::Delivery { seq: pending.seq, privacy: sender.privacy.clone(),
                mobile: sender.mobile.clone(), shared: sender.local_share.clone() });
            let actions = match &mut rt.engine {
                Engine::Acp(a) => match delivery {
                    Some(delivery) => a.prompt_with_delivery(q.text.clone(), q.images.clone(), Some(delivery)),
                    None => a.prompt(q.text.clone(), q.images.clone()),
                },
                Engine::OpenCode(o) => {
                    o.set_prompt_seq(pending.seq);
                    o.prompt(q.text.clone(), q.images.clone())
                },
                // A PTY tab never queues here: the CLI holds typed input
                // itself, so the message went in when it was written.
                Engine::CodexStdio(_) | Engine::Cli(_) | Engine::None => Vec::new(),
            };
            // ACP may retain this local follow-up until its handshake
            // completes. It owns the next turn even before it has writes.
            let sent = !actions.is_empty() || matches!(&rt.engine, Engine::Acp(a) if a.waiting_for_session());
            self.apply_actions(rt, actions);
            if sent {
                rt.open_turn();
                rt.turn_started_at = Some(Instant::now());
                self.set_status(rt, TabStatus::InProgress);
                return true;
            }
        }
        false
    }

    fn on_exit(&self, rt_arc: &Arc<Mutex<TabRuntime>>, pid: u32, code: Option<i32>) {
        let mut rt = rt_arc.lock().unwrap();
        if rt.child_pid != Some(pid) {
            return; // an older child; the live one is unaffected
        }
        crate::cloud_grants::forget_launch(&rt.key());
        self.withdraw_acp_input(&mut rt);
        rt.child = None;
        rt.child_pid = None;
        self.note_child(&rt);
        rt.engine = Engine::None;
        self.retire_provider(&rt);
        self.settle_settings_without_process(&mut rt);
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
            self.publish(&mut rt, Payload::TurnCompleted { status, final_text, usage: None, duration_ms, head: None, auth_failed: false, detail: None }, None);
        }
        rt.queued.clear();
        self.with_provider_state(&rt, |state| state.queue.clear());
        if let Some(kind) = recovery { self.needs_recovery(&mut rt, kind, crate::recovery_log::Source::Connection); }
        else { self.set_status(&mut rt, TabStatus::Idle); }
    }
}

struct TabSink {
    manager: SessionManager,
    rt: Arc<Mutex<TabRuntime>>,
    epoch: std::sync::atomic::AtomicU64,
    child: Mutex<Option<std::sync::Weak<crate::harness::host::LiveChild>>>,
}

impl Sink for TabSink {
    fn stdout_line(&self, line: String) {
        let child = {
            // spawn_child publishes the exact Arc while holding runtime.
            // An eager child must wait for that publication, not lose output.
            let _runtime = self.rt.lock().unwrap();
            self.child.lock().unwrap().as_ref().and_then(std::sync::Weak::upgrade)
        };
        let Some(child) = child else { return };
        self.manager.on_acp_line_from(&self.rt, &line, &child, &self.epoch);
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
#[path = "session_mobile_admission_tests.rs"]
mod mobile_admission_tests;

// Their agents are stand-in `#!/bin/sh` CLIs.
#[cfg(test)]
#[path = "session_mobile_controls_tests.rs"]
mod mobile_controls_tests;

#[cfg(test)]
#[path = "session_follow_tests.rs"]
mod follow_tests;

#[cfg(test)]
#[path = "session_unsent_tests.rs"]
mod unsent_tests;

#[cfg(test)]
#[path = "session_idle_tests.rs"]
mod idle_tests;

#[cfg(test)]
#[path = "session_send_tests.rs"]
mod send_tests;

#[cfg(test)]
#[path = "session_agent_key_tests.rs"]
mod agent_key_tests;

#[cfg(test)]
#[path = "account_launch_tests.rs"]
mod account_launch_tests;

#[cfg(test)]
static BEFORE_OPENCODE_HTTP: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    #[test]
    fn a_bound_guest_provider_never_receives_or_probes_the_host_container() {
        use crate::cloud_config::LaunchConfig;
        for args in [" --strict-mcp-config --mcp-config 'guest binding'", " -c 'mcp_servers={guest_computer={}}'", " -c 'mcp_servers={}'"] {
            let guest = LaunchConfig { env: vec![("TERMINALX_LOCAL_VM_ENVIRONMENT_ID".into(), "bound".into())], args: args.into(), prompt: None };
            let (env, computer) = computer_launch(guest, || panic!("must not inspect or route the host container")).unwrap();
            assert_eq!(computer.args, args);
            assert_eq!(computer.note, None);
            assert_eq!(env, [("TERMINALX_LOCAL_VM_ENVIRONMENT_ID".into(), "bound".into())]);
        }
    }

    #[test]
    fn a_host_provider_gets_the_local_vm_and_one_appended_prompt() {
        use crate::cloud_config::LaunchConfig;
        let (env, computer) = computer_launch(LaunchConfig::default(), || Ok(crate::container_vm::VmLaunch {
            args: crate::container_vm::agent_args("claude", "docker"), note: crate::container_vm::agent_note("claude"),
        })).unwrap();
        assert!(env.is_empty());
        assert!(computer.args.contains("cua-driver") && !computer.args.contains("--append-system-prompt"));
        let prompt = crate::cloud_config::prompt_argv("claude", &[Some("workspace"), computer.note]);
        assert_eq!(prompt.iter().filter(|word| *word == "--append-system-prompt").count(), 1);
        assert!(prompt[1].contains("workspace") && prompt[1].contains("host.docker.internal"));
    }

    #[test]
    fn a_new_tabs_first_start_is_told_without_waiting_and_only_while_watched() {
        let starts = FirstStarts::default();
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        // A healthy new tab: its first showing starts it at once, and again.
        starts.added("s/a".into(), t0);
        assert_eq!(starts.on_open("s/a", at(0)), OnOpen::Start);
        assert!(starts.starting("s/a"));
        assert_eq!(starts.on_open("s/a", at(300)), OnOpen::Start);
        // Its agent exited while starting: every window that shows it while watched is told why.
        starts.exited("s/a", Some("claude exited while starting\nbad json".into()), at(900));
        assert!(!starts.starting("s/a"));
        assert_eq!(starts.on_open("s/a", at(1_000)), OnOpen::Fail("claude exited while starting\nbad json".into()));
        assert_eq!(starts.on_open("s/a", at(5_000)), OnOpen::Fail("claude exited while starting\nbad json".into()));
        // Closed, or no longer watched: started as any other tab is.
        starts.forget("s/a");
        assert_eq!(starts.on_open("s/a", at(5_000)), OnOpen::Start);
        starts.added("s/e".into(), t0);
        starts.exited("s/e", Some("bad json".into()), at(500));
        assert_eq!(starts.on_open("s/e", at(500 + FIRST_START_WATCH.as_millis() as u64)), OnOpen::Start);
        assert_eq!(starts.on_open("s/e", at(500)), OnOpen::Start);

        // Gone after it got going, or stopped: the window asking after the exit starts nothing, once.
        starts.added("s/b".into(), t0);
        starts.exited("s/b", None, at(2_000));
        assert_eq!(starts.on_open("s/b", at(2_100)), OnOpen::Leave);
        assert_eq!(starts.on_open("s/b", at(2_200)), OnOpen::Start);
        // A second exit is not the first start's.
        starts.exited("s/b", Some("later".into()), at(3_000));
        assert_eq!(starts.on_open("s/b", at(3_100)), OnOpen::Start);

        // Past the watch, nothing is told apart any more.
        starts.added("s/c".into(), t0);
        starts.exited("s/c", Some("late".into()), at(FIRST_START_WATCH.as_millis() as u64));
        assert_eq!(starts.on_open("s/c", at(11_000)), OnOpen::Start);
        starts.added("s/d".into(), t0);
        assert_eq!(starts.on_open("s/d", at(FIRST_START_WATCH.as_millis() as u64)), OnOpen::Start);
        assert!(!starts.starting("s/d"));
        // A tab never added here is started as always.
        assert_eq!(starts.on_open("s/x", at(0)), OnOpen::Start);
    }

    #[test]
    fn closing_waits_as_long_as_its_message_says() {
        assert_eq!(STOP_CONFIRM_WAIT, Duration::from_secs(recovery::CLOSE_WAIT_SECS));
        assert!(STOP_CONFIRM_WAIT >= RESTART_WAIT, "the stop's own kill wait fits inside it");
        assert_eq!(recovery::close_timed_out(agent_name("codex")), "Codex didn't stop within 10 seconds");
    }

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
        let prompt = PromptText { bot: None, request_id: None, collaboration: collaboration_v2::current(), files: Vec::new(), hold_if_busy: None, mobile: None, shared_connection: None, author: None, agent: "describe this".into(), display: "describe this".into() };
        let image = ImageRef { url: "attachments/session/proof.png".into(), media_type: Some("image/png".into()), name: Some("proof.png".into()) };
        let mut pending = std::collections::VecDeque::new();
        let mut projected = Vec::new();

        for _ in 0..2 {
            let (composer, echo) = cli_composer_message(&prompt, vec![image.clone()], None, false, "/workspace");
            pending.push_back(echo);
            projected.push(composer);

            let rollout = Payload::UserMessage { author: None, bot: None, text: "[Image #1] describe this".into(), images: Vec::new(), files: Vec::new(), baseline: None, queued: false, cwd: None };
            assert_eq!(consume_composer_echo(&mut pending, &rollout), Some(Echoed { queued: false, seq: 0, overtaken: false, continuation: false, changed: false, into: None }));
        }

        assert_eq!(projected.len(), 2, "one projected record per real submission");
        assert!(projected.iter().all(|p| matches!(p, Payload::UserMessage { text, images, .. } if text == "describe this" && images.as_slice() == std::slice::from_ref(&image))));
    }

    #[test]
    fn revert_context_reaches_the_agent_without_becoming_the_users_visible_message() {
        let mut prompt = PromptText { bot: None, request_id: None, collaboration: collaboration_v2::current(), files: Vec::new(), hold_if_busy: None, mobile: None, shared_connection: None, author: None, agent: "Continue".into(), display: "Continue".into() };
        prompt.append_agent_context("The user reverted a.txt from turn 1.");
        let (message, echo) = cli_composer_message(&prompt, vec![], None, false, "/workspace");
        assert!(prompt.agent.ends_with("The user reverted a.txt from turn 1."));
        assert!(matches!(message, Payload::UserMessage { text, .. } if text == "Continue"));
        assert!(echo.matches(&prompt.agent), "the provider echo of the augmented prompt must be deduplicated");
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

    /// A `!command` sent from the composer comes back as the CLI's record of
    /// the command it ran (#1294), not as a second message.
    #[test]
    fn composer_echo_matches_a_shell_passthrough_command() {
        let echo = ComposerEcho::new("!git status".into(), 0);
        assert!(echo.matches("<bash-input> git status</bash-input>"));
        assert!(echo.matches("<bash-input>git  status</bash-input>\n<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>"));
        assert!(!echo.matches("<bash-input> git log</bash-input>"));
        assert!(!echo.matches("<bash-stdout>git status</bash-stdout>"));
        assert!(!ComposerEcho::new("git status".into(), 0).matches("<bash-input> git status</bash-input>"));
        assert_eq!(bash_input("<bash-input>ls</bash-input>"), Some("ls"));
        assert_eq!(bash_input("<bash-input>ls"), None);
    }

    /// #1383. Input tags around the command, then anything that is not the
    /// rest of a shell record, are a prompt of the reader's: no `!command`
    /// echo, though the tags hold its words.
    #[test]
    fn composer_echo_matches_only_a_whole_shell_record() {
        let echo = ComposerEcho::new("!pwd".into(), 0);
        for prompt in [
            "<bash-input>pwd</bash-input> please explain",
            "<bash-input>pwd</bash-input> please explain <bash-stdout>ok</bash-stdout>",
            "<bash-input>pwd</bash-input><bash-input>ls</bash-input>",
            "<bash-input>pwd</bash-input><bash-exit-code>0</bash-exit-code><bash-exit-code>1</bash-exit-code>",
            "<bash-input>pwd</bash-input><bash-stderr>x</bash-stderr><bash-stdout>y</bash-stdout>",
            "<bash-input>pwd</bash-stdout>",
        ] {
            assert!(!echo.matches(prompt), "{prompt}");
            assert_eq!(shell_command(prompt), None, "{prompt}");
        }
        for record in [
            "<bash-input>pwd</bash-input>",
            "<bash-input> pwd</bash-input>\n<bash-stdout>/tmp</bash-stdout><bash-stderr></bash-stderr>",
            "<bash-input>pwd</bash-input><bash-stderr>denied</bash-stderr>",
        ] {
            assert!(echo.matches(record), "{record}");
        }
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
        // Claude Code numbers pasted images across the session: a later prompt's labels start where the count stands.
        assert_eq!(strip_image_labels("[Image #12]beside dust, add an option"), (1, "beside dust, add an option"));
        assert_eq!(strip_image_labels("[Image #7] [Image #8] compare"), (2, " compare"));
        assert_eq!(strip_image_labels("[Image #7] [Image #9] compare"), (1, " [Image #9] compare"));
        assert_eq!(strip_image_labels("[Image #0] x"), (0, "[Image #0] x"));
        assert!(ComposerEcho::new("beside dust, add an option".into(), 1).matches("[Image #12]beside dust, add an option"));
        assert_eq!(strip_image_labels("[Image #] x"), (0, "[Image #] x"));
        assert_eq!(strip_image_labels("[Image #1 x"), (0, "[Image #1 x"));
    }

    #[test]
    fn delivery_is_confirmed_by_the_matching_provider_echo_after_submission() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut echo = ComposerEcho::new("continuation prompt".into(), 0);
        echo.receipt = Some(tx);
        let mut pending = std::collections::VecDeque::from([echo]);
        let message = |text: &str| Payload::UserMessage { author: None, bot: None, text: text.into(), images: Vec::new(), files: Vec::new(), baseline: None, queued: false, cwd: None };
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
        let user = |text: &str| Payload::UserMessage { author: None, bot: None, text: text.into(), images: Vec::new(), files: Vec::new(), baseline: None, queued: false, cwd: None };

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

        // Codex: an unchanged allowed PreToolUse call is an acknowledgement.
        // A bare permissionDecision:allow is rejected by Codex 0.164.0.
        assert_eq!(out(CliKind::Codex, "PreToolUse", Decision::Allow), json!({}));
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

    /// What runs is the call, whichever gate asks and however the agent
    /// words it (PRO-160); a different command or input is another call.
    #[test]
    fn a_repeat_is_told_by_what_it_runs() {
        let pre = asked_to_run(&json!({"command": "touch /x"}));
        assert_eq!(pre, asked_to_run(&json!({"command": "touch /x", "description": "May I write /x?"})));
        assert_eq!(pre, asked_to_run(&json!({"command": "touch /x", "description": "I need /x."})));
        assert_eq!(asked_to_run(&json!({"command": "*** Begin Patch\n*** End Patch\n"})), asked_to_run(&json!({"command": "*** Begin Patch\n*** End Patch"})));
        assert_ne!(pre, asked_to_run(&json!({"command": "touch /y"})));
        assert_ne!(pre, asked_to_run(&json!({"command": "touch /x", "workdir": "/elsewhere"})));
        assert_ne!(asked_to_run(&json!({"server": "a", "args": {"q": 1}})), asked_to_run(&json!({"server": "a", "args": {"q": 2}})));
        let cmd = asked_to_run(&json!({"cmd": "touch note", "workdir": "/workspace/app"}));
        assert_eq!(cmd, asked_to_run(&json!({"cmd": "touch note\n", "workdir": "/workspace/app", "justification": "Make a note"})));
        assert_ne!(cmd, asked_to_run(&json!({"cmd": "rm file", "workdir": "/workspace/app"})));
        assert_ne!(cmd, asked_to_run(&json!({"cmd": "touch note", "workdir": "/workspace/other"})));
        assert_ne!(cmd, asked_to_run(&json!({"cmd": "touch note", "workdir": "/workspace/app", "shell": "other-shell"})));
    }

    #[test]
    fn only_the_tabs_that_are_their_cli_are_pty_first() {
        assert_eq!(pty_first("claude"), Some(CliKind::Claude));
        assert_eq!(pty_first("codex"), Some(CliKind::Codex));
        assert_eq!(pty_first("cursor"), None);
        assert_eq!(pty_first("opencode"), None);
    }
}

#[cfg(test)]
#[path = "session_review_tests.rs"]
mod review_tests;

impl SessionManager {
    pub(crate) fn collaboration_v2_witness(&self, session: &str, tab: &str) -> Option<collaboration_v2::TabWitness> {
        let rt = self.runtime(session, tab).ok()?;
        let rt = rt.lock().unwrap();
        Self::collaboration_witness(&rt)
    }

    fn collaboration_witness(rt: &TabRuntime) -> Option<collaboration_v2::TabWitness> {
        let entry = index::get(&rt.session_id).ok()?;
        let tab = entry.tab(&rt.tab_id)?;
        let (owned, actual) = match &rt.engine {
            Engine::Cli(cli) => (cli.by_hand.is_none() && !rt.stopping && rt.restart_claim.is_none()
                && rt.collaboration_raw.as_ref().is_none_or(|tail| !Arc::ptr_eq(tail, &cli.tail)),
                rt.collaboration_stance.as_ref().filter(|(tail, _)| Arc::ptr_eq(tail, &cli.tail)).map(|(_, stance)| stance.clone())),
            Engine::CodexStdio(engine) => (!engine.exited && !engine.blocked && !rt.stopping, engine.actual_stance.clone()),
            _ => (false, None),
        };
        Some(collaboration_v2::TabWitness {
            owned: owned && !tab.by_hand() && !tab.is_terminal(), harness: tab.harness.clone(),
            stored_mode: tab.permission_mode.clone(), pending_mode: tab.requested_permission_mode.clone(), actual,
        })
    }

    fn check_collaboration_permit(permit: &CollaborationPermit, rt: &TabRuntime) -> Result<()> {
        permit.check(Self::collaboration_witness(rt).as_ref())
    }

    /// The legacy writer retries a full PTY as before. V2 retries also
    /// recheck original authority and tab state before each physical Enter,
    /// releasing both locks while waiting for capacity.
    fn submit_collaboration_prompt(&self, runtime: &Arc<Mutex<TabRuntime>>, permit: Option<&CollaborationPermit>, pane: &str,
        sequences: (Option<u64>, Option<u64>), watched: bool, stopped: impl Fn(&TabRuntime) -> bool) -> Result<bool> {
        let (seq, receipt_seq) = sequences;
        let started = Instant::now();
        let pid = self.terminals.pid(pane);
        loop {
            let result = {
                let _policy = permit.map(|permit| permit.collaboration.enter_admission());
                let guarded = permit.is_some_and(|permit| permit.collaboration.runtime_policy.is_v2());
                Self::submit_composer_prompt(runtime, seq, receipt_seq, watched,
                    |rt| stopped(rt) || permit.is_some_and(|permit| Self::check_collaboration_permit(permit, rt).is_err()),
                    || {
                        if !guarded { return self.terminals.write(pane, tui::SUBMIT); }
                        let pid = pid.context("terminal process missing")?;
                        anyhow::ensure!(self.terminals.try_write_for_process(pane, pid, tui::SUBMIT)? == tui::SUBMIT.len(), "terminal submit incomplete");
                        Ok(())
                    })
            };
            match result {
                Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|error| matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted)) => {
                    #[cfg(test)]
                    if let Some(blocked) = COLLABORATION_PTY_CAPACITY.lock().unwrap().take() { let _ = blocked.send(()); }
                    if started.elapsed() >= pty::INPUT_STALL {
                        return Err(pty::InputStalled { written: 0, total: tui::SUBMIT.len() }.into());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                result => return result,
            }
        }
    }

    fn write_collaboration_prompt(&self, runtime: &Arc<Mutex<TabRuntime>>, permit: Option<&CollaborationPermit>, ready: Option<&Arc<tui::Ready>>, pane: &str, bytes: &[u8]) -> Result<()> {
        // Preserve the legacy retrying writer (including flush and its stall
        // budget). Only v2 needs to release the tab lock between attempts.
        {
            let _policy = permit.map(|permit| permit.collaboration.enter_admission());
            if permit.is_none_or(|permit| !permit.collaboration.runtime_policy.is_v2()) {
                return self.terminals.write(pane, bytes);
            }
        }
        let pid = self.terminals.pid(pane).context("terminal process missing")?;
        let mut offset = 0;
        let started = Instant::now();
        let mut progress = started;
        loop {
            let attempted = {
                let _policy = permit.map(|permit| permit.collaboration.enter_admission());
                let rt = runtime.lock().unwrap();
                if let Some(permit) = permit { Self::check_collaboration_permit(permit, &rt)?; }
                anyhow::ensure!(matches!(&rt.engine, Engine::Cli(cli) if cli.pane_id == pane && ready.is_none_or(|ready| Arc::ptr_eq(ready, &cli.ready))), "Terminal instance changed before input");
                self.terminals.try_write_for_process(pane, pid, &bytes[offset..])
            };
            match attempted {
                Ok(_) if offset == bytes.len() => return Ok(()), // guarded flush
                Ok(0) => bail!("terminal input closed"),
                Ok(written) => { offset += written; progress = Instant::now(); }
                Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|error| matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted)) => {
                    #[cfg(test)]
                    if let Some(blocked) = COLLABORATION_PTY_CAPACITY.lock().unwrap().take() { let _ = blocked.send(()); }
                    if progress.elapsed() >= pty::INPUT_STALL || started.elapsed() >= pty::INPUT_DEADLINE {
                        return Err(pty::InputStalled { written: offset, total: bytes.len() }.into());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl SessionManager {
    /// Raw terminal input can change stance without a reliable report. Latch
    /// this launch unknown for Everyone until a managed replacement; a delayed
    /// provider report from before the raw write cannot make it safe again.
    pub(crate) fn with_raw_terminal_input<T>(&self, pane: &str, write: impl FnOnce() -> Result<T>) -> Result<T> {
        let runtimes: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        for runtime in runtimes {
            let mut rt = runtime.lock().unwrap();
            if let Engine::Cli(cli) = &rt.engine {
                if cli.pane_id == pane {
                    rt.collaboration_raw = Some(cli.tail.clone());
                    drop(rt);
                    return write();
                }
            }
        }
        write()
    }
}

#[cfg(test)]
#[path = "session_acp_collaboration_tests.rs"]
mod provider_acp_collaboration;

// ACP's native owner path is selected only after original ingress supplies a
// carrier (or private integration tests select it). Public V2 entry refusals
// and the generic drain refusal remain in place pending acceptance.
impl SessionManager {
    fn carried_acp(&self, rt: &TabRuntime) -> bool {
        matches!(rt.engine, Engine::Acp(_)) && self.with_provider_state(rt, |state| state.acp_carried)
    }

    fn retain_acp_operation(&self, rt: &TabRuntime, context: &provider_authority::OperationContext) {
        self.with_provider_state(rt, |state| {
            state.acp_carried = true;
            state.operations.insert(context.operation_id().into(), context.clone());
        });
    }

    /// No guard escapes this call. Workers call it once per short syscall or
    /// whole callback, never around a frame/capacity/network wait.
    fn with_provider_admission(&self, runtime: &Arc<Mutex<TabRuntime>>,
        context: &provider_authority::OperationContext,
        run: impl FnOnce(&mut TabRuntime) -> Result<provider_authority::Attempt>,
    ) -> Result<provider_authority::Attempt> {
        use provider_authority::Attempt;
        let sender = context.sender();
        let _policy = match sender.permit() {
            Some(permit) => match permit.collaboration.try_enter_admission() {
                Some(guard) => Some(guard), None => return Ok(Attempt::Deferred),
            }, None => None,
        };
        // The session's identity is captured at ingress, not looked up by PID.
        let (session, tab) = context.destination();
        // lock(), not lock_for(): a Hold fence must not wait while policy is
        // held. check below refuses held work; writer waits own no guards.
        let _session = crate::issue_pipeline::admission::lock();
        let _privacy = sender.privacy.iter()
            .chain(sender.mobile.iter().map(|permit| &permit.grant.privacy))
            .chain(sender.local_share.iter().map(|permit| &permit.privacy))
            .map(|ticket| ticket.enter()).collect::<Result<Vec<_>>>()?;
        let mut sharing = (sender.mobile.is_some() || sender.local_share.is_some()).then(|| self.sharing.lock().unwrap());
        let mut attachment = None;
        if let Some(permit) = &sender.local_share {
            let share = sharing.as_mut().and_then(|s| s.sessions.get_mut(session)).context("Sharing ended before ACP delivery")?;
            share.admit_at_writer(permit, tab, chrono::Utc::now().timestamp_millis())?;
            attachment = share.owner.as_ref().map(|owner| owner.attachment.clone());
            let entry = index::get(session)?;
            anyhow::ensure!(entry.tab(tab).is_some_and(|tab| !tab.by_hand() && settings::allowed_while_shared(&tab.permission_mode)), "Shared ACP association or mode changed");
        }
        if let Some(permit) = &sender.mobile { permit.check_mode(session, tab)?; }
        let _mobile = sender.mobile.as_ref().map(|permit| permit.enter()).transpose()?;
        let _owner = attachment.as_ref().map(|attachment| attachment.enter()).transpose()?;
        let mut rt = runtime.lock().unwrap();
        anyhow::ensure!(rt.session_id == session && rt.tab_id == tab && !rt.stopping, "ACP owner retired");
        self.accepting_work()?;
        crate::issue_pipeline::admission::check(session, tab)?;
        run(&mut rt)
    }

    /// Pure exact-request gate. The authority check itself remains in the
    /// original OperationContext immediately before the physical syscall.
    fn acp_request_current(&self, rt: &TabRuntime, context: &provider_authority::OperationContext) -> bool {
        use provider_authority::Correlation;
        let Engine::Acp(a) = &rt.engine else { return false };
        let request = match context.correlation() {
            Correlation::Opening { request, .. } | Correlation::Prompt { request, .. } => request.parse::<u64>().ok(),
            Correlation::Setting { setting, request_id, adapter_request } => {
                let exact = self.with_provider_state(rt, |state| state.settings.get(setting).is_some_and(|current|
                    matches!(current.correlation(), Correlation::Setting { request_id: id, .. } if id == request_id)));
                if !exact { return false; }
                let Ok(entry) = index::get(&rt.session_id) else { return false };
                let Some(tab) = entry.tab(&rt.tab_id) else { return false };
                let settings = Settings::of(tab);
                if context.sender().permit().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2()) && settings.collaboration_requests().get(setting) != Some(request_id) { return false; }
                // Local edits are keyed by the native sidecar; a remote intent
                // replacing one also retires that sidecar at ingress.
                if !context.sender().is_remote() && settings.collaboration_requests().contains_key(setting) { return false; }
                adapter_request.parse::<u64>().ok()
            },
            Correlation::Approval { .. } => return a.answer_current(context),
            Correlation::Control { .. } => return true,
        };
        request.is_some_and(|id| a.request_current(id, context))
    }

    fn capture_acp_setting(&self, rt: &mut TabRuntime, settings: &Settings, setting: &str,
        original: Option<&CollaborationPermit>,
    ) -> Result<provider_authority::OperationContext> {
        use provider_authority::{Correlation, OperationContext, RequiredAction, SenderAuthority};
        let binding = self.provider_binding(rt).context("ACP setting has no association")?;
        let request_id = settings.collaboration_requests().get(setting).cloned().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // A persisted remote requirement cannot turn into explicit Local.
        if settings.collaboration_requests().contains_key(setting) {
            anyhow::ensure!(original.is_some(), "original ACP Configure request carrier missing");
        }
        let sender = SenderAuthority::capture(original.cloned(), RequiredAction::Configure, settings.provider_ticket(setting), None, None);
        let context = OperationContext::new(sender, RequiredAction::Configure, binding,
            Correlation::Setting { setting: setting.into(), request_id, adapter_request: String::new() });
        self.with_provider_state(rt, |state| {
            if let Some(old) = state.settings.insert(setting.into(), context.clone()) { old.withdraw(); }
        });
        Ok(context)
    }

    fn retain_acp_opening_configuration(&self, rt: &mut TabRuntime) -> Result<()> {
        if matches!(&rt.engine, Engine::Acp(a) if a.ready) { return Ok(()); }
        let entry = index::get(&rt.session_id)?;
        let settings = Settings::of(entry.tab(&rt.tab_id).context("tab not found")?);
        for setting in ["model", "mode"] {
            let existing = self.with_provider_state(rt, |state| state.settings.get(setting).cloned());
            let context = if let Some(context) = existing { context } else {
                let original = settings.collaboration_requests().get(setting)
                    .and_then(|id| rt.collaboration_settings.get(id)).cloned();
                self.capture_acp_setting(rt, &settings, setting, original.as_ref())?
            };
            if let Engine::Acp(a) = &mut rt.engine { a.retain_setting(context)?; }
        }
        Ok(())
    }

    fn send_acp_carried(&self, rt: &mut TabRuntime, text: String, images: Vec<(String, String)>,
        delivery: acp::Delivery, original: provider_authority::OperationContext,
    ) -> Result<()> {
        self.retain_acp_operation(rt, &original);
        self.retain_acp_opening_configuration(rt)?;
        let Engine::Acp(a) = &mut rt.engine else { bail!("ACP association missing") };
        anyhow::ensure!(!a.waiting_for_session(), "ACP opening already owns its original prompt; successor must remain queued");
        let actions = if a.ready { a.prompt_carried(text, images, delivery, original)? }
            else { a.start_carried(text, images, delivery, original)? };
        self.stage_acp_actions(rt, actions);
        Ok(())
    }

    /// Only physical ACP actions leave the callback. Read-only effects execute
    /// inside its ONE admission; no second per-action callback consumption.
    fn stage_acp_actions(&self, rt: &mut TabRuntime, actions: Vec<crate::harness::ProviderAction>) {
        for envelope in actions {
            self.retain_acp_operation(rt, &envelope.context);
            if let provider_authority::Correlation::Prompt { seq, .. } = envelope.context.correlation() {
                self.with_provider_state(rt, |state| state.operations.retain(|id, original| {
                    let handed_off = id != envelope.context.operation_id()
                        && matches!(original.correlation(), provider_authority::Correlation::Prompt { seq: original_seq, .. } if original_seq == seq);
                    if handed_off { original.seal_origin(); }
                    !handed_off
                }));
            }
            match &envelope.action {
                Action::Write(_) | Action::AcpPrompt(_) | Action::AcpMode { .. } => {
                    // Spawning doesn't dispatch bytes; this thread still owns
                    // runtime. Writer obtains fresh ordered gates afterwards.
                    let manager = self.clone();
                    let runtime = rt.me.clone();
                    let child = rt.child.clone();
                    std::thread::spawn(move || {
                        let (Some(runtime), Some(child)) = (runtime.upgrade(), child) else { envelope.context.withdraw(); return };
                        manager.write_acp_carried(&runtime, &child, envelope);
                    });
                },
                Action::Http { .. } => { envelope.context.withdraw(); }, // C remains unintegrated
                _ => self.apply_actions(rt, vec![envelope.action]),
            }
        }
    }

    fn settle_acp_setting(&self, rt: &mut TabRuntime, context: &provider_authority::OperationContext,
        success: bool, actions: &mut Vec<crate::harness::ProviderAction>,
    ) -> Result<()> {
        use provider_authority::Correlation;
        let Correlation::Setting { setting, request_id, .. } = context.correlation() else { return Ok(()) };
        // acp_request_current was checked before handle consumed its request.
        let remote = context.sender().permit().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2());
        self.update_settings(rt, |s| {
            let exact = !remote || s.collaboration_requests().get(setting) == Some(request_id);
            if !exact { return; }
            if success {
                if remote { s.settle_provider_request(setting, request_id); }
                else { s.settle_local_provider_request(setting); }
            } else {
                // Model refusal retains BOTH native Configure ID and the
                // legacy request ID. Never apply a value-only refusal.
                for envelope in actions.iter() {
                    if let Action::AcpModelRefused { request_id: legacy, model, .. } = &envelope.action {
                        if setting == "model" && s.model_request_id() == Some(legacy.as_str()) {
                            s.refused(Setting::Model, Some(model));
                        }
                    }
                }
            }
        })?;
        actions.retain(|envelope| !matches!(&envelope.action,
            Action::Emit(Payload::ProviderSettings { .. }) | Action::AcpModelRefused { .. }));
        self.with_provider_state(rt, |state| {
            if state.settings.get(setting).is_some_and(|original|
                matches!(original.correlation(), Correlation::Setting { request_id: id, .. } if id == request_id)) {
                state.settings.remove(setting);
            }
        });
        Ok(())
    }

    fn write_acp_carried(&self, runtime: &Arc<Mutex<TabRuntime>>, child: &Arc<crate::harness::host::LiveChild>,
        envelope: crate::harness::ProviderAction,
    ) {
        use provider_authority::{Attempt, Correlation, StreamOutcome};
        let context = envelope.context;
        let (line, prompt, no_wire) = match envelope.action {
            Action::Write(line) => (Some(line), None, false),
            Action::AcpPrompt(write) => (Some(write.line.clone()), Some(write), false),
            Action::AcpMode { line, .. } => { let none = line.is_none(); (line, None, none) },
            _ => { context.withdraw(); return },
        };
        let Ok(mut stream) = context.reserve_stream() else { return };
        // Cleanup tickets count in-flight I/O rather than holding policy or
        // sender mutexes. Privacy acknowledgement follows captured-pipe cleanup.
        // EACH independent ticket is retained, including distinct constraints.
        let cleanup = context.sender().privacy.iter()
            .chain(context.sender().mobile.iter().map(|p| &p.grant.privacy))
            .chain(context.sender().local_share.iter().map(|p| &p.privacy))
            .map(|ticket| ticket.enter()).collect::<Result<Vec<_>>>();
        let mut emitted = false;
        let mut offset = 0usize;
        let total = line.as_ref().map_or(0, |line| line.len() + 1);
        let no_response = matches!(context.correlation(), Correlation::Approval { .. } | Correlation::Control { .. });
        let result = (|| -> Result<()> {
            cleanup.as_ref().map_err(|error| anyhow!("{error:#}"))?;
            if no_wire {
                loop {
                    let result = self.with_provider_admission(runtime, &context, |rt| {
                        let binding = self.provider_binding(rt).context("ACP association missing")?;
                        anyhow::ensure!(binding.matches_child(child), "ACP no-wire child replaced");
                        let Correlation::Setting { setting, request_id, .. } = context.correlation() else { bail!("ACP no-wire mode requires Configure identity") };
                        anyhow::ensure!(self.with_provider_state(rt, |state| state.settings.get(setting).is_some_and(|current| current.operation_id() == context.operation_id())), "ACP mode request replaced");
                        let entry = index::get(&rt.session_id)?;
                        let settings = Settings::of(entry.tab(&rt.tab_id).context("ACP mode tab missing")?);
                        if context.sender().permit().is_some_and(|permit| permit.collaboration.runtime_policy.is_v2()) {
                            anyhow::ensure!(settings.collaboration_requests().get(setting) == Some(request_id), "ACP no-wire Configure intent replaced");
                        }
                        let witness = Self::collaboration_witness(rt);
                        let attempt = stream.try_confirm(&binding, witness.as_ref())?;
                        // No OS write for a provider-known no-op. Still reserve,
                        // validate exact Configure, and settle only that intent.
                        if attempt == Attempt::Applied {
                            let mut actions = Vec::new();
                            self.settle_acp_setting(rt, &context, true, &mut actions)?;
                        }
                        let _ = request_id;
                        Ok(attempt)
                    })?;
                    if result == Attempt::Deferred { std::thread::sleep(Duration::from_millis(5)); continue; }
                    anyhow::ensure!(result == Attempt::Applied, "ACP no-wire withdrawn");
                    return Ok(());
                }
            }
            acp::write_carried_frame(&context, child, line.as_deref().context("ACP frame missing")?,
                |original, exact_child, bytes| {
                    let mut chunk = acp::Chunk::Withdrawn;
                    let admitted = self.with_provider_admission(runtime, original, |rt| {
                        let binding = self.provider_binding(rt).context("ACP association missing")?;
                        anyhow::ensure!(binding.matches_child(exact_child) && self.acp_request_current(rt, original), "ACP exact request or child retired");
                        let witness = Self::collaboration_witness(rt);
                        let (attempt, syscall) = stream.try_chunk(&binding, original.correlation(), witness.as_ref(), |_| Ok(()),
                            || exact_child.try_write_stdin(&bytes[..bytes.len().min(4096)]))?;
                        chunk = match syscall {
                            Some(Ok(n)) => { offset += n; acp::Chunk::Written(n) },
                            Some(Err(error)) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {
                                #[cfg(test)]
                                if let Some(observed) = ACP_FULL_PIPE.lock().unwrap().take() { let _ = observed.send(()); }
                                acp::Chunk::Capacity
                            },
                            Some(Err(error)) => return Err(error.into()),
                            None if attempt == Attempt::Deferred => acp::Chunk::Deferred,
                            None => acp::Chunk::Withdrawn,
                        };
                        if offset == total && attempt == Attempt::Applied {
                            anyhow::ensure!(stream.finish(if no_response { StreamOutcome::Complete } else { StreamOutcome::Response }), "ACP full frame cancelled");
                            if let Some(write) = &prompt {
                                if let Engine::Acp(a) = &mut rt.engine { a.delivered(write.id); }
                                recovery::diagnose_send(&rt.diagnostics_path(), write.delivery.seq, "delivered", serde_json::json!({"since_sent_ms":0}));
                                self.apply(rt, write.started.clone(), None);
                                self.apply(rt, Payload::ModelRequestStarted, None);
                            }
                            if let Correlation::Approval { ask_id, .. } = original.correlation() {
                                let delivered = match &mut rt.engine { Engine::Acp(a) => a.answer_delivered(original), _ => None };
                                if let Some(allow) = delivered {
                                    self.permission_delivered(rt, ask_id, allow);
                                }
                            }
                            emitted = true;
                        }
                        Ok(attempt)
                    })?;
                    Ok(if admitted == Attempt::Deferred { acp::Chunk::Deferred } else { chunk })
                }, || { std::thread::sleep(Duration::from_millis(5)); Ok(()) })
        })();
        if result.is_err() {
            stream.finish(if stream.written() == 0 { StreamOutcome::Refused } else { StreamOutcome::Unknown });
            self.retire_acp_original(runtime, child, &context, stream.written() > 0);
        }
        if emitted || no_wire || result.is_err() {
            let rt = runtime.lock().unwrap();
            self.with_provider_state(&rt, |state| { state.operations.remove(context.operation_id()); });
        }
        // Child cleanup/withdrawal above precedes privacy acknowledgement.
        drop(cleanup);
        if emitted && matches!(context.correlation(), Correlation::Approval { .. }) {
            let (session, tab) = context.destination();
            self.observer.answered(session, tab);
        }
        if result.is_err() { self.drain_carried_acp_queue(runtime); }
    }

    fn retire_acp_original(&self, runtime: &Arc<Mutex<TabRuntime>>, child: &Arc<crate::harness::host::LiveChild>,
        context: &provider_authority::OperationContext, partial: bool,
    ) {
        use provider_authority::Correlation;
        context.withdraw();
        if partial { child.close_stdin(); }
        let mut rt = runtime.lock().unwrap();
        if !rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, child)) { return; }
        let input = matches!(context.correlation(), Correlation::Prompt { .. } | Correlation::Opening { .. });
        if let Engine::Acp(a) = &mut rt.engine {
            let id = match context.correlation() {
                Correlation::Prompt { request, .. } | Correlation::Opening { request, .. } => request.parse().ok(),
                Correlation::Setting { adapter_request, .. } => adapter_request.parse().ok(),
                _ => None,
            };
            if let Some(id) = id { a.retire_request(id, context); }
        }
        if input || partial {
            // Retire only this association. Queue successors have their OWN
            // untouched original senders; never drain under this callback TLS.
            if let Engine::Acp(a) = &mut rt.engine { a.withdraw_carriers(); }
            child.close_stdin();
            rt.child = None;
            rt.child_pid = None;
            self.note_child(&rt);
            self.with_provider_state(&rt, |state| {
                state.binding = None;
                for original in state.operations.values() { original.withdraw(); }
                state.operations.clear();
                state.settings.clear();
            });
            if let Correlation::Prompt { seq, .. } = context.correlation() { self.prompt_withdrawn(&mut rt, *seq, None); }
            rt.turn_open = false;
            // Local successor remains queued and is launched independently by
            // drain_carried_acp_queue, outside all original callback gates.
        }
    }

    fn acp_response_batch(&self, runtime: &Arc<Mutex<TabRuntime>>, child: &Arc<crate::harness::host::LiveChild>,
        line: &str, context: &provider_authority::OperationContext,
    ) -> Result<provider_authority::Attempt> {
        use provider_authority::Attempt;
        if context.callback_finished() { return Ok(Attempt::Withdrawn); }
        let value: serde_json::Value = serde_json::from_str(line)?;
        let id = value["id"].as_u64().context("ACP response request missing")?;
        let success = value.get("error").is_none_or(|error| error.is_null());
        let mut staged = Vec::new();
        let result = self.with_provider_admission(runtime, context, |rt| {
            let binding = self.provider_binding(rt).context("ACP response association missing")?;
            anyhow::ensure!(binding.matches_child(child), "ACP response child replaced");
            if !self.acp_request_current(rt, context) { return Ok(Attempt::Withdrawn); }
            let witness = Self::collaboration_witness(rt);
            context.try_callback(&binding, context.correlation(), witness.as_ref(), |_| Ok(()), || {
                let Engine::Acp(a) = &mut rt.engine else { bail!("ACP response engine retired") };
                // The adapter is touched only AFTER exact child/request checks
                // and the once-only whole-batch callback reservation.
                let mut actions = a.handle_carried_response(line, context)?;
                self.settle_acp_setting(rt, context, success, &mut actions)?;
                for envelope in actions {
                    match &envelope.action {
                        Action::Write(_) | Action::AcpPrompt(_) | Action::AcpMode { .. } => staged.push(envelope),
                        Action::Http { .. } => { envelope.context.withdraw(); },
                        Action::Emit(Payload::ProviderSettings { .. }) => {},
                        _ => self.apply_actions(rt, vec![envelope.action]),
                    }
                }
                Ok(())
            })
        });
        match result {
            Ok(Attempt::Applied) => {
                let mut rt = runtime.lock().unwrap();
                // Derived envelopes were created inside callback; physical
                // dispatch starts only after every callback gate was released.
                self.with_provider_state(&rt, |state| { state.operations.remove(context.operation_id()); });
                if rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, child)) { self.stage_acp_actions(&mut rt, staged); }
                else { for envelope in staged { envelope.context.withdraw(); } }
                Ok(Attempt::Applied)
            },
            Ok(Attempt::Deferred) => Ok(Attempt::Deferred), // retain EXACT raw line + context on caller's worker
            _ => {
                // Another callback may have completed while this local batch
                // waited for session admission. Duplicate delivery is inert.
                if context.callback_finished() { return Ok(Attempt::Withdrawn); }
                let mut rt = runtime.lock().unwrap();
                if rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, child)) {
                    if let Engine::Acp(a) = &mut rt.engine { a.retire_request(id, context); }
                }
                drop(rt);
                self.retire_acp_original(runtime, child, context, false);
                Ok(Attempt::Withdrawn)
            },
        }
    }

    fn on_acp_line_from(&self, runtime: &Arc<Mutex<TabRuntime>>, line: &str,
        child: &Arc<crate::harness::host::LiveChild>, epoch: &std::sync::atomic::AtomicU64,
    ) {
        let context = {
            let mut rt = runtime.lock().unwrap();
            if rt.stopping || child.epoch != epoch.load(std::sync::atomic::Ordering::Acquire)
                || !rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, child)) { return; }
            if !self.carried_acp(&rt) {
                drop(rt);
                self.on_line_from(runtime, line, Some(epoch));
                return;
            }
            let Some(binding) = self.provider_binding(&rt).filter(|binding| binding.matches_child(child)) else { return };
            let _ = binding; // association-only read fence, no old prompt Drive
            let value: serde_json::Value = match serde_json::from_str(line) { Ok(value) => value, Err(_) => return };
            if let Some(method) = value["method"].as_str() {
                // Only read-only output/permission asks enter here. Filesystem
                // RPCs need their separately reviewed mutation owner, not Drive.
                if !matches!(method, "session/update" | "session/request_permission") { return; }
                let Engine::Acp(a) = &mut rt.engine else { return };
                let actions = a.handle(line).into_iter().filter(|action| !matches!(action,
                    Action::Write(_) | Action::AcpPrompt(_) | Action::AcpMode { .. }
                    | Action::Http { .. } | Action::Emit(Payload::ProviderSettings { .. }))).collect();
                self.apply_actions(&mut rt, actions);
                return;
            }
            let Engine::Acp(a) = &rt.engine else { return };
            a.response_context(line)
        };
        let Some(context) = context else { return };
        let manager = self.clone();
        let runtime = runtime.clone();
        let child = child.clone();
        let line = line.to_string();
        std::thread::spawn(move || {
            while let Ok(provider_authority::Attempt::Deferred) = manager.acp_response_batch(&runtime, &child, &line, &context) {
                std::thread::sleep(Duration::from_millis(5));
            }
            manager.drain_carried_acp_queue(&runtime);
        });
    }
}

impl SessionManager {
    fn drain_carried_acp_queue(&self, runtime: &Arc<Mutex<TabRuntime>>) {
        use provider_authority::{RequiredAction, Attempt};
        loop {
            let mut rt = runtime.lock().unwrap();
            if rt.stopping || rt.recovery.is_some() || rt.turn_open || rt.queued.is_empty() { return; }
            if matches!(&rt.engine, Engine::Acp(a) if a.waiting_for_session())
                || self.opencode_opening(&rt) { return; }
            let pending = rt.queued.remove(0);
            let original = self.with_provider_state(&rt, |state| state.queue.remove(pending.seq, &pending.message.id));
            // Restore cannot recover a required original sender. Refuse before
            // starting a process, without synthesizing a Permit from JSON/TLS.
            if original.is_none() && provider_authority::queue_requirement(&pending.message.id) == provider_authority::QueueRequirement::NeedsOriginalCarrier {
                self.publish(&mut rt, Payload::PromptWithdrawn { prompt_seq: pending.seq, unconfirmed: false }, None);
                continue;
            }
            let policy = original.as_ref().and_then(|context| context.sender().permit()).cloned();
            let _policy = match &policy {
                Some(permit) => match permit.collaboration.try_enter_admission() {
                    Some(guard) => Some(guard), None => {
                        if let Some(original) = original { self.with_provider_state(&rt, |state| state.queue.reinsert(pending.seq, pending.message.id.clone(), original)); }
                        rt.queued.insert(0, pending);
                        drop(rt);
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    },
                }, None => None,
            };
            let witness = Self::collaboration_witness(&rt);
            if original.as_ref().is_some_and(|context| context.sender().check(RequiredAction::Drive, witness.as_ref()).is_err())
                || pending.privacy.as_ref().is_some_and(|ticket| !ticket.valid()) {
                if let Some(original) = original { original.withdraw(); }
                self.publish(&mut rt, Payload::PromptWithdrawn { prompt_seq: pending.seq, unconfirmed: false }, None);
                continue;
            }
            if rt.child.is_none() {
                let launch = (|| -> Result<()> {
                    let entry = index::get(&rt.session_id)?;
                    let tab = entry.tab(&rt.tab_id).context("ACP queue tab missing")?;
                    match HarnessId::parse(&tab.harness) {
                        HarnessId::Acp(binary) => self.start_acp(&mut rt, runtime, &entry, tab, &entry.cwd, &binary),
                        HarnessId::OpenCode => self.start_opencode(&mut rt, runtime, &entry, tab, &entry.cwd),
                        _ => bail!("carried queue engine replaced"),
                    }
                })();
                if launch.is_err() {
                    if let Some(original) = original { original.withdraw(); }
                    self.publish(&mut rt, Payload::PromptWithdrawn { prompt_seq: pending.seq, unconfirmed: false }, None);
                    continue;
                }
            }
            let Some(binding) = self.provider_binding(&rt) else { return };
            let original = match original {
                Some(original) => match original.bind_queued(binding.clone()) { Ok(original) => original, Err(_) => continue },
                None => self.with_provider_state(&rt, |state| state.queue.take(pending.seq, &pending.message.id, pending.privacy.clone(), binding)),
            };
            let sender = original.sender();
            let delivery = acp::Delivery { seq: pending.seq, privacy: sender.privacy.clone(), mobile: sender.mobile.clone(), shared: sender.local_share.clone() };
            let result = if matches!(rt.engine, Engine::OpenCode(_)) {
                self.send_opencode_carried(&mut rt, pending.message.text, pending.message.images, pending.seq, original.clone())
            } else {
                self.send_acp_carried(&mut rt, pending.message.text, pending.message.images, delivery, original.clone())
            };
            if result.is_err() {
                original.withdraw();
                self.publish(&mut rt, Payload::PromptWithdrawn { prompt_seq: pending.seq, unconfirmed: false }, None);
                continue;
            }
            rt.open_turn();
            rt.turn_started_at = Some(Instant::now());
            self.set_status(&mut rt, TabStatus::InProgress);
            let _ = Attempt::Applied;
            return;
        }
    }
}

/// Source-authored manager regressions, ALL UNRUN pending root B collection
/// and a fresh serial allocation. No per-syscall child contexts in this fixture.
#[cfg(test)]
mod provider_integration_d {
    use super::*;
    use super::provider_authority::{Attempt, Correlation, OperationContext, RequiredAction, SenderAuthority};
    use crate::remote::collab::{Collaboration, v2::{Action as Right, Permit, Snapshot}};
    use serde_json::json;
    use std::sync::mpsc;

    const SESSION: &str = "provider-integration-d";
    const TAB: &str = "acp";
    const AGENT: &str = r#"
import json, os, pathlib, select, sys, time
base=pathlib.Path(sys.argv[1]); buffer=b''; held=None
print('{"fixture":"ready"}', flush=True)
while True:
    if (base/'pause').exists():
        (base/'paused').touch()
        while (base/'pause').exists(): time.sleep(.002)
    if not select.select([0],[],[],.01)[0]: continue
    data=os.read(0,4096)
    if not data:
        (base/'eof').touch(); break
    with (base/'bytes').open('ab') as f: f.write(data)
    buffer+=data
    while b'\n' in buffer:
        line,buffer=buffer.split(b'\n',1); v=json.loads(line)
        with (base/'requests').open('a') as f: f.write(json.dumps(v)+'\n')
        method=v.get('method')
        if method is None:
            if held is not None:
                print(json.dumps({'id':held,'result':{'stopReason':'end_turn'}}),flush=True); held=None
            continue
        if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{}}
        elif method=='session/new': result={'sessionId':'same-id','modes':{'currentModeId':'normal','availableModes':[{'id':'normal'},{'id':'plan'}]}}
        elif method=='session/prompt':
            if any(x.get('text')=='ask' for x in v['params']['prompt']):
                held=v['id']
                options=json.loads((base/'permission-options').read_text()) if (base/'permission-options').exists() else [{'optionId':'allow','kind':'allow_once'},{'optionId':'deny','kind':'reject_once'}]
                print(json.dumps({'id':77,'method':'session/request_permission','params':{'toolCall':{'toolCallId':'tool','kind':'execute'},'options':options}}),flush=True)
                continue
            result={'stopReason':'end_turn'}
        elif method=='session/set_mode': result={'modeId':v['params']['modeId']}
        else: result={}
        print(json.dumps({'jsonrpc':'2.0','id':v['id'],'result':result}),flush=True)
"#;

    struct Inbox(Mutex<mpsc::Sender<String>>);
    impl Sink for Inbox {
        fn stdout_line(&self, line: String) { let _ = self.0.lock().unwrap().send(line); }
        fn stderr_line(&self, _: String) {}
        fn exited(&self, _: u32, _: Option<i32>) {}
    }
    #[cfg_attr(not(unix), allow(dead_code))]
    struct Rig {
        manager: SessionManager,
        rt: Arc<Mutex<TabRuntime>>,
        child: Arc<LiveChild>,
        lines: mpsc::Receiver<String>,
        dir: tempfile::TempDir,
        policy: Arc<Collaboration>,
        _home: store::TempHome,
    }
    fn until(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready() {
            assert!(Instant::now() < deadline, "session ACP barrier timed out");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    #[cfg_attr(not(unix), allow(dead_code))]
    impl Rig {
        fn new() -> Self {
            let home = store::temp_home();
            let dir = tempfile::tempdir().unwrap();
            index::save(&[serde_json::from_value(json!({"id":SESSION,"projectPath":dir.path(),"cwd":dir.path(),
                "title":"D integration","created":index::now(),"modified":index::now(),
                "tabs":[{"id":TAB,"harness":"cursor","model":"base","permissionMode":"auto","created":index::now()}]})).unwrap()]).unwrap();
            let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)), Arc::new(crate::sink::NoObserver),
                Arc::new(Host::new()), Arc::new(pty::Terminals::new()), Arc::default(), Arc::default(), crate::hooks::prepare_control().unwrap());
            let rt = manager.runtime(SESSION, TAB).unwrap();
            let (child, lines) = Self::spawn(&manager, dir.path());
            {
                let mut runtime = rt.lock().unwrap();
                runtime.child = Some(child.clone()); runtime.child_pid = Some(child.pid);
                runtime.engine = Engine::Acp(acp::Acp::new(dir.path().to_str().unwrap(), None, None, "auto"));
                manager.with_provider_state(&runtime, |state| state.acp_carried = true);
            }
            let policy = Arc::new(Collaboration::new());
            policy.runtime_policy.bind(dir.path(), 1).unwrap();
            let rig = Self { manager, rt, child, lines, dir, policy, _home: home };
            rig.revision("1");
            rig
        }
        fn spawn(manager: &SessionManager, path: &Path) -> (Arc<LiveChild>, mpsc::Receiver<String>) {
            let program = crate::binpath::python3_path().expect("real ACP fixture requires python3");
            let args = vec!["-u".into(), "-c".into(), AGENT.into(), path.to_string_lossy().into_owned()];
            let (tx, rx) = mpsc::channel();
            let child = manager.host.spawn(&uuid::Uuid::new_v4().to_string(), SpawnSpec { program: &program, args: &args,
                cwd: path, env: &[], unset: &[] }, Arc::new(Inbox(Mutex::new(tx)))).unwrap();
            assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().contains("ready"));
            (child, rx)
        }
        fn revision(&self, revision: &str) {
            self.policy.install_v2(serde_json::from_value::<Snapshot>(json!({"v":2,"revision":revision,"members":[
                {"userId":"explicit","role":"manager","canApprove":true,"approvalSource":"explicit", "writeSource":"explicit"},
                {"userId":"everyone","role":"driver","canApprove":false,"writeSource":"everyone"}]})).unwrap()).unwrap();
        }
        fn permit(&self, right: Right) -> Permit { Permit::new(self.policy.clone(), "explicit", self.policy.runtime_policy.stamp("explicit"), right) }
        fn operation(&self, seq: u64, permit: Option<Permit>) -> OperationContext {
            let binding = self.manager.provider_binding(&self.rt.lock().unwrap()).unwrap();
            OperationContext::new(SenderAuthority::capture(permit, RequiredAction::Drive, None, None, None), RequiredAction::Drive,
                binding, Correlation::Prompt { seq, request: format!("original-{seq}") })
        }
        fn send(&self, seq: u64, text: String, permit: Option<Permit>) -> OperationContext {
            let context = self.operation(seq, permit);
            let mut rt = self.rt.lock().unwrap();
            self.manager.send_acp_carried(&mut rt, text, vec![], acp::Delivery { seq, privacy: None, mobile: None, shared: None }, context.clone()).unwrap();
            rt.open_turn();
            context
        }
        fn line(&self) -> String { self.lines.recv_timeout(Duration::from_secs(5)).expect("real ACP reply") }
        fn context(&self, line: &str) -> OperationContext {
            let rt = self.rt.lock().unwrap(); let Engine::Acp(a) = &rt.engine else { panic!("ACP retired") };
            a.response_context(line).expect("native exact response context")
        }
        fn reply_with(&self, line: &str, context: &OperationContext) -> Attempt {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let result = self.manager.acp_response_batch(&self.rt, &self.child, line, context).unwrap();
                if result != Attempt::Deferred { return result; }
                assert!(std::time::Instant::now() < deadline, "ACP response admission remained deferred");
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        fn reply(&self, line: &str) -> Attempt {
            // The real callback worker retains this exact native context while
            // admission is occupied by a concurrent physical writer.
            self.reply_with(line, &self.context(line))
        }
        fn ready(&self) {
            self.send(1, "first".into(), None);
            loop {
                let line = self.line(); assert_eq!(self.reply(&line), Attempt::Applied);
                if line.contains("stopReason") { break; }
            }
            until(|| !self.rt.lock().unwrap().turn_open);
        }
        fn requests(&self) -> Vec<Value> {
            std::fs::read_to_string(self.dir.path().join("requests")).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
        }
        fn configure(&self, setting: &str, value: &str, permit: Option<&Permit>) -> OperationContext {
            let mut rt = self.rt.lock().unwrap();
            let (_, settings) = self.manager.update_settings(&mut rt, |s| {
                if setting == "model" { s.request_model_explicit(value, true, permit, None); }
                else { s.request_mode_explicit(value, true, permit, None); }
                s.retain_provider_request(setting, permit, None);
            }).unwrap();
            SessionManager::remember_configuration(&mut rt, &settings, setting, permit);
            let context = self.manager.capture_acp_setting(&mut rt, &settings, setting, permit).unwrap();
            let Engine::Acp(a) = &mut rt.engine else { panic!("ACP") };
            let actions = if setting == "model" { a.set_model_carried(value, settings.model_request_id().map(String::from), context.clone()).unwrap() }
                else { a.set_mode_carried(value, context.clone()).unwrap() };
            self.manager.stage_acp_actions(&mut rt, actions);
            context
        }
        fn settings(&self) -> Settings { Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap()) }
    }
    impl Drop for Rig { fn drop(&mut self) { self.manager.host.kill_all(); } }

    #[cfg(unix)]
    #[test]
    fn provider_integration_d_whole_batch_deferred_and_duplicate_opening() {
        let rig = Rig::new();
        rig.send(1, "first".into(), Some(rig.permit(Right::Drive)));
        assert_eq!(rig.reply(&rig.line()), Attempt::Applied); // initialize -> new
        let raw = rig.line(); let original = rig.context(&raw);
        let policy = rig.policy.clone();
        let (ready, waiting) = mpsc::channel(); let (release, released) = mpsc::channel();
        let holder = std::thread::spawn(move || { let _guard = policy.enter_admission(); ready.send(()).unwrap(); released.recv_timeout(Duration::from_secs(5)).unwrap(); });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(rig.manager.acp_response_batch(&rig.rt, &rig.child, &raw, &original).unwrap(), Attempt::Deferred);
        assert_eq!(rig.context(&raw).operation_id(), original.operation_id());
        release.send(()).unwrap(); holder.join().unwrap();
        assert_eq!(rig.manager.acp_response_batch(&rig.rt, &rig.child, &raw, &original).unwrap(), Attempt::Applied);
        assert_eq!(rig.manager.acp_response_batch(&rig.rt, &rig.child, &raw, &original).unwrap(), Attempt::Withdrawn);
        assert!(rig.rt.lock().unwrap().child.as_ref().is_some_and(|child| Arc::ptr_eq(child, &rig.child)));
        assert_eq!(rig.reply(&rig.line()), Attempt::Applied);
        assert_eq!(rig.requests().iter().filter(|v| v["method"] == "session/prompt").count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn provider_integration_d_exact_model_and_mode_ack_do_not_settle_newer_intent() {
        let rig = Rig::new(); rig.ready();
        let permit = rig.permit(Right::Configure);
        rig.configure("model", "same", Some(&permit));
        let old = rig.line(); let old_context = rig.context(&old);
        let old_id = rig.settings().collaboration_requests()["model"].clone();
        rig.revision("2");
        let permit = rig.permit(Right::Configure);
        rig.configure("model", "same", Some(&permit));
        let new_id = rig.settings().collaboration_requests()["model"].clone();
        assert_ne!(old_id, new_id);
        assert_eq!(rig.reply_with(&old, &old_context), Attempt::Withdrawn);
        assert_eq!(rig.settings().collaboration_requests()["model"], new_id);
        assert_eq!(rig.reply(&rig.line()), Attempt::Applied);
        assert_eq!(rig.settings().model, "same");
        let mode = rig.configure("mode", "plan", Some(&permit));
        let raw = rig.line();
        assert!(matches!(rig.context(&raw).correlation(), Correlation::Setting { setting, request_id, .. }
            if setting == "mode" && matches!(mode.correlation(), Correlation::Setting { request_id: original, .. } if original == request_id)));
        assert_eq!(rig.reply(&raw), Attempt::Applied);
        assert_eq!(rig.settings().permission_mode, "plan");
        assert!(rig.settings().requested_permission_mode.is_none());
        // Exact no-wire confirmation uses a separate Configure reservation,
        // without a fake syscall or nonexistent Setting::Mode.
        let mode_writes = rig.requests().iter().filter(|request| request["method"] == "session/set_mode").count();
        rig.configure("mode", "plan", Some(&permit));
        until(|| !rig.manager.with_provider_state(&rig.rt.lock().unwrap(), |s| s.settings.contains_key("mode")));
        assert_eq!(rig.settings().permission_mode, "plan");
        assert_eq!(rig.requests().iter().filter(|request| request["method"] == "session/set_mode").count(), mode_writes,
            "provider-confirmed no-wire mode must not enqueue another RPC");
    }

    #[cfg(unix)]
    #[test]
    fn provider_integration_d_approval_attempt_new_deny_retires_old_allow_on_real_writer() {
        let rig = Rig::new(); rig.ready();
        rig.send(2, "ask".into(), None);
        let ask = rig.line(); assert!(ask.contains("request_permission"));
        let epoch = std::sync::atomic::AtomicU64::new(rig.child.epoch);
        rig.manager.on_acp_line_from(&rig.rt, &ask, &rig.child, &epoch);
        let approval = rig.permit(Right::Approve);
        let binding = rig.manager.provider_binding(&rig.rt.lock().unwrap()).unwrap();
        let allow = {
            let mut rt = rig.rt.lock().unwrap();
            let Engine::Acp(a) = &mut rt.engine else { panic!("ACP") };
            a.answer_carried("acp:77", "allow", OperationContext::new(SenderAuthority::capture(Some(approval.clone()), RequiredAction::Approve, None, None, None),
                RequiredAction::Approve, binding, Correlation::Approval { ask_id:"acp:77".into(),provider_request:"77".into(),attempt:"old-allow".into() })).unwrap()
        };
        approval.with(|| rig.manager.respond_permission(SESSION, TAB, "acp:77", "deny")).unwrap();
        rig.manager.write_acp_carried(&rig.rt, &rig.child, allow);
        until(|| !rig.rt.lock().unwrap().pending.contains_key("acp:77"));
        assert_eq!(rig.reply(&rig.line()), Attempt::Applied);
        let answers: Vec<_> = rig.requests().into_iter().filter(|v| v["id"] == 77).collect();
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0]["result"]["outcome"]["optionId"], "deny");
    }

    #[cfg(unix)]
    #[test]
    fn provider_integration_d_approval_opaque_ids_publish_option_kind_after_real_delivery() {
        for (choice, kind, allowed) in [("opaque-allow-42", "reject_once", false), ("opaque-42", "allow_once", true),
            ("opaque-deny-42", "allow_always", true)] {
            let rig = Rig::new(); rig.ready();
            std::fs::write(rig.dir.path().join("permission-options"), json!([
                {"optionId":choice,"kind":kind}]).to_string()).unwrap();
            rig.send(2, "ask".into(), None);
            let ask = rig.line();
            let epoch = std::sync::atomic::AtomicU64::new(rig.child.epoch);
            rig.manager.on_acp_line_from(&rig.rt, &ask, &rig.child, &epoch);
            let decisions = Arc::new(Mutex::new(Vec::new()));
            let observed = decisions.clone();
            let listener = rig.manager.sink.listen("agent_event", Box::new(move |raw| {
                let event: crate::events::AgentEvent = serde_json::from_str(raw).unwrap();
                if let Payload::PermissionDecided { request_id, allowed, label, .. } = event.payload {
                    observed.lock().unwrap().push((request_id, allowed, label));
                }
            }));
            let approval = rig.permit(Right::Approve);
            approval.with(|| rig.manager.respond_permission(SESSION, TAB, "acp:77", choice)).unwrap();
            until(|| !decisions.lock().unwrap().is_empty());
            assert_eq!(*decisions.lock().unwrap(), vec![("acp:77".into(), allowed,
                if allowed { "Allowed".into() } else { "Denied".into() })]);
            until(|| rig.requests().iter().any(|v| v["id"] == 77));
            let answers: Vec<_> = rig.requests().into_iter().filter(|v| v["id"] == 77).collect();
            assert_eq!(answers.len(), 1);
            assert_eq!(answers[0]["result"]["outcome"], json!({"outcome":"selected","optionId":choice}));
            rig.manager.sink.unlisten(listener);
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_integration_d_approval_unknown_mapping_refuses_without_wire_or_decision() {
        for options in [json!([{"optionId":"opaque-allow","kind":"future_kind"}]),
            json!([{"optionId":"opaque-allow"}]),
            json!([{"optionId":"opaque-allow","kind":"allow_once"}, {"optionId":"opaque-allow","kind":"reject_once"}]),
            json!([{"optionId":"different","kind":"allow_once"}])] {
            let rig = Rig::new(); rig.ready();
            std::fs::write(rig.dir.path().join("permission-options"), options.to_string()).unwrap();
            rig.send(2, "ask".into(), None);
            let ask = rig.line();
            let epoch = std::sync::atomic::AtomicU64::new(rig.child.epoch);
            rig.manager.on_acp_line_from(&rig.rt, &ask, &rig.child, &epoch);
            let decisions = Arc::new(Mutex::new(Vec::new()));
            let observed = decisions.clone();
            let listener = rig.manager.sink.listen("agent_event", Box::new(move |raw| {
                let event: crate::events::AgentEvent = serde_json::from_str(raw).unwrap();
                if let Payload::PermissionDecided { .. } = event.payload { observed.lock().unwrap().push(()); }
            }));
            let approval = rig.permit(Right::Approve);
            assert!(approval.with(|| rig.manager.respond_permission(SESSION, TAB, "acp:77", "opaque-allow")).is_err());
            assert!(rig.requests().iter().all(|v| v["id"] != 77), "unknown metadata must not produce a frame");
            assert!(decisions.lock().unwrap().is_empty());
            assert!(rig.rt.lock().unwrap().pending.contains_key("acp:77"));
            rig.manager.sink.unlisten(listener);
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_integration_d_actual_partial_frame_wouldblock_revoke_stop_and_replacement() {
        for change in ["revision", "stop", "replacement"] {
            let rig = Rig::new(); rig.ready();
            let before = std::fs::read(rig.dir.path().join("bytes")).unwrap().len();
            std::fs::write(rig.dir.path().join("pause"), b"").unwrap();
            until(|| rig.dir.path().join("paused").exists());
            let (full, observed) = mpsc::channel(); *ACP_FULL_PIPE.lock().unwrap() = Some(full);
            let original = rig.send(20, "x".repeat(4 * 1024 * 1024), Some(rig.permit(Right::Drive)));
            observed.recv_timeout(Duration::from_secs(5)).expect("manager writer reaches real WouldBlock");
            let replacement_dir = tempfile::tempdir().unwrap();
            let mut replacement = None;
            match change {
                "revision" => rig.revision("2"), // would deadlock if capacity wait retained policy
                "stop" => { let mut rt = rig.rt.lock().unwrap(); rt.stopping = true; if let Engine::Acp(a) = &mut rt.engine { a.withdraw_carriers(); } },
                "replacement" => {
                    let (child, lines) = Rig::spawn(&rig.manager, replacement_dir.path());
                    let mut rt = rig.rt.lock().unwrap();
                    rt.child = Some(child.clone()); rt.child_pid = Some(child.pid);
                    rt.engine = Engine::Acp(acp::Acp::new(replacement_dir.path().to_str().unwrap(), None, None, "auto"));
                    rt.turn_open = false;
                    rig.manager.with_provider_state(&rt, |s| {
                        s.binding = None;
                        for original in s.operations.values().chain(s.settings.values()) { original.withdraw(); }
                        s.operations.clear(); s.settings.clear();
                    });
                    replacement = Some((child, lines));
                }, _ => unreachable!(),
            }
            std::fs::remove_file(rig.dir.path().join("pause")).unwrap();
            until(|| rig.dir.path().join("eof").exists());
            let bytes = std::fs::read(rig.dir.path().join("bytes")).unwrap();
            assert!(!bytes[before..].is_empty()); assert!(!bytes[before..].contains(&b'\n'));
            assert!(original.derive_follow_on(Correlation::Control { request:"replay".into(),kind:"replay".into() }).is_err());
            if let Some((child, lines)) = replacement {
                assert!(rig.rt.lock().unwrap().child.as_ref().is_some_and(|current| Arc::ptr_eq(current, &child)));
                assert!(!replacement_dir.path().join("bytes").exists(), "no old tail reaches replacement");
                let local = rig.operation(21, None);
                {
                    let mut rt = rig.rt.lock().unwrap();
                    let id = rig.manager.with_provider_state(&rt, |state| state.queue.insert(21, local));
                    rt.queued.push(PendingMessage { message: QueuedMessage { id, text:"local successor".into(),images:vec![] },privacy:None,seq:21 });
                }
                rig.manager.drain_carried_acp_queue(&rig.rt);
                loop {
                    let line = lines.recv_timeout(Duration::from_secs(5)).unwrap();
                    let context = rig.context(&line); assert!(!context.sender().is_remote());
                    assert_eq!(rig.manager.acp_response_batch(&rig.rt, &child, &line, &context).unwrap(), Attempt::Applied);
                    if line.contains("stopReason") { break; }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_integration_d_queue_restore_missing_remote_and_explicit_local_under_other_tls() {
        let rig = Rig::new(); rig.ready();
        let remote = rig.operation(30, Some(rig.permit(Right::Drive)));
        let local = rig.operation(31, None);
        {
            let mut rt = rig.rt.lock().unwrap();
            for (seq, operation) in [(30, remote), (31, local)] {
                let id = rig.manager.with_provider_state(&rt, |state| state.queue.insert(seq, operation));
                let pending = PendingMessage { message: QueuedMessage { id: id.clone(), text:format!("restored-{seq}"),images:vec![] }, privacy:None, seq };
                let restored: PendingMessage = serde_json::from_value(serde_json::to_value(pending).unwrap()).unwrap();
                rig.manager.with_provider_state(&rt, |state| { state.queue.remove(seq, &id); });
                rt.queued.push(restored);
            }
        }
        let unrelated = Permit::new(rig.policy.clone(), "everyone", rig.policy.runtime_policy.stamp("everyone"), Right::Drive);
        unrelated.with(|| rig.manager.drain_carried_acp_queue(&rig.rt));
        let raw = rig.line(); let context = rig.context(&raw); assert!(!context.sender().is_remote());
        assert_eq!(rig.reply(&raw), Attempt::Applied);
        let requests = rig.requests();
        let serialized = serde_json::to_string(&requests).unwrap();
        assert!(!serialized.contains("restored-30")); assert!(serialized.contains("restored-31"));
    }

    #[test]
    fn provider_integration_d_frame_wait_rechecks_revision_generation_and_original_attachment() {
        for change in ["revision", "generation", "attachment"] {
            let rig = Rig::new();
            let (peer, _notifications) = crate::remote::server::Peer::for_user("original".into(), crate::remote::protocol::Authority::Manage, Some("explicit".into()));
            let permit = Permit::new(rig.policy.clone(), "explicit", rig.policy.runtime_policy.stamp_for_peer("explicit", &peer), Right::Drive).for_peer(&peer);
            let frame = rig.child.input_frame().unwrap();
            rig.send(1, "held original".into(), Some(permit));
            // The writer cannot touch policy/runtime while waiting for frame;
            // each change completes before it gets permission to try a syscall.
            match change {
                "revision" => rig.revision("2"),
                "generation" => rig.policy.runtime_policy.set_generation(2),
                "attachment" => drop(peer),
                _ => unreachable!(),
            }
            drop(frame);
            until(|| rig.rt.lock().unwrap().child.is_none());
            assert!(rig.requests().is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_integration_d_revoked_opening_keeps_queued_local_successor_independent() {
        let rig = Rig::new();
        rig.send(1, "old remote opening".into(), Some(rig.permit(Right::Drive)));
        let raw = rig.line(); let opening = rig.context(&raw);
        let successor = rig.operation(2, None);
        {
            let mut rt = rig.rt.lock().unwrap();
            let id = rig.manager.with_provider_state(&rt, |s| s.queue.insert(2, successor));
            rt.queued.push(PendingMessage { message:QueuedMessage { id,text:"queued local successor".into(),images:vec![] },privacy:None,seq:2 });
        }
        rig.revision("2");
        assert_eq!(rig.manager.acp_response_batch(&rig.rt, &rig.child, &raw, &opening).unwrap(), Attempt::Withdrawn);
        assert_eq!(rig.rt.lock().unwrap().queued.len(), 1);
        let fresh = tempfile::tempdir().unwrap(); let (child, lines) = Rig::spawn(&rig.manager, fresh.path());
        {
            let mut rt = rig.rt.lock().unwrap(); rt.child = Some(child.clone()); rt.child_pid = Some(child.pid);
            rt.engine = Engine::Acp(acp::Acp::new(fresh.path().to_str().unwrap(), None, None, "auto"));
        }
        let unrelated = Permit::new(rig.policy.clone(), "everyone", rig.policy.runtime_policy.stamp("everyone"), Right::Drive);
        unrelated.with(|| rig.manager.drain_carried_acp_queue(&rig.rt));
        loop {
            let raw = lines.recv_timeout(Duration::from_secs(5)).unwrap(); let context = rig.context(&raw);
            assert!(!context.sender().is_remote());
            assert_eq!(rig.manager.acp_response_batch(&rig.rt, &child, &raw, &context).unwrap(), Attempt::Applied);
            if raw.contains("stopReason") { break; }
        }
        assert!(!serde_json::to_string(&rig.requests()).unwrap().contains("session/prompt"));
        let requests = std::fs::read_to_string(fresh.path().join("requests")).unwrap();
        assert!(requests.contains("queued local successor"));
        // Late output carries the old exact child and cannot enter replacement.
        let before = rig.rt.lock().unwrap().seq;
        rig.manager.on_acp_line_from(&rig.rt, &raw, &rig.child, &std::sync::atomic::AtomicU64::new(rig.child.epoch));
        assert_eq!(rig.rt.lock().unwrap().seq, before);
    }

    #[test]
    fn provider_integration_d_independent_local_privacy_refusal_before_real_pipe() {
        let rig = Rig::new();
        let binding = rig.manager.provider_binding(&rig.rt.lock().unwrap()).unwrap();
        let context = OperationContext::new(SenderAuthority::capture(None, RequiredAction::Drive,
            Some(crate::data_privacy::Ticket::denied()), None, None), RequiredAction::Drive, binding,
            Correlation::Prompt { seq:99,request:"private-local".into() });
        {
            let mut rt = rig.rt.lock().unwrap();
            rig.manager.send_acp_carried(&mut rt, "must not write".into(), vec![], acp::Delivery { seq:99,privacy:None,mobile:None,shared:None }, context).unwrap();
        }
        until(|| rig.rt.lock().unwrap().child.is_none());
        assert!(rig.requests().is_empty());
    }
}

#[cfg(test)]
mod provider_integration_d_stream_lifecycle {
    #[cfg(unix)]
    use super::*;
    #[cfg(unix)]
    use provider_authority::{Attempt, Correlation, OperationContext, ProviderBinding, RequiredAction, SenderAuthority, StreamOutcome};

    #[cfg(unix)]
    /// Real Host/pipe, SAME operation reservation across byte-by-byte writes.
    /// The manager partial-frame test separately forces actual WouldBlock.
    #[test]
    fn provider_integration_d_stream_reserve_once_full_newline_then_callback_once() {
        struct Lines(std::sync::mpsc::Sender<String>);
        impl Sink for Lines {
            fn stdout_line(&self, line: String) { let _ = self.0.send(line); }
            fn stderr_line(&self, _: String) {}
            fn exited(&self, _: u32, _: Option<i32>) {}
        }
        let host = Host::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let program = crate::binpath::python3_path().unwrap();
        let args = vec!["-u".into(), "-c".into(), "import sys; print(sys.stdin.readline().strip(), flush=True)".into()];
        let child = host.spawn("provider-integration-d-stream", SpawnSpec { program:&program,args:&args,cwd:&std::env::temp_dir(),env:&[],unset:&[] }, Arc::new(Lines(tx))).unwrap();
        let binding = ProviderBinding::owned("stream", "tab", &child);
        let context = OperationContext::new(SenderAuthority::capture(None, RequiredAction::Drive, None, None, None), RequiredAction::Drive,
            binding.clone(), Correlation::Prompt { seq:1,request:"exact".into() });
        let mut stream = context.reserve_stream().unwrap();
        assert!(context.reserve_stream().is_err(), "cloned envelope cannot reserve another frame");
        let mut offset = 0;
        let mut callbacks = 0;
        acp::write_carried_frame(&context, &child, "actual frame", |original, child, bytes| {
            assert_eq!(original.operation_id(), context.operation_id());
            let (admission, result) = stream.try_chunk(&binding, context.correlation(), None, |_| Ok(()), || child.try_write_stdin(&bytes[..1]))?;
            assert_eq!(admission, Attempt::Applied);
            match result.unwrap()? {
                1 => { offset += 1; Ok(acp::Chunk::Written(1)) },
                _ => anyhow::bail!("short one-byte pipe unexpectedly closed"),
            }
        }, || Ok(())).unwrap();
        assert_eq!(offset, "actual frame\n".len());
        assert!(context.stream_current(&binding), "newline completion is finalized by the owner, not first chunk");
        assert!(stream.finish(StreamOutcome::Response));
        assert!(!stream.finish(StreamOutcome::Response));
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "actual frame");
        assert_eq!(context.try_callback(&binding, context.correlation(), None, |_| Ok(()), || { callbacks += 1; Ok(()) }).unwrap(), Attempt::Applied);
        assert_eq!(context.try_callback(&binding, context.correlation(), None, |_| Ok(()), || { callbacks += 1; Ok(()) }).unwrap(), Attempt::Withdrawn);
        assert_eq!(callbacks, 1);
        host.kill_all();
    }
}

// OpenCode owner integration is selected only by retained native ingress or
// private tests. Public V2 entry blocks and unsupported Everyone remain above.
impl SessionManager {
    fn carried_opencode(&self, rt: &TabRuntime) -> bool {
        matches!(rt.engine, Engine::OpenCode(_)) && self.with_provider_state(rt, |s| s.opencode.carried)
    }

    fn opencode_opening(&self, rt: &TabRuntime) -> bool {
        self.carried_opencode(rt) && self.with_provider_state(rt, |s| s.opencode.preparing.is_some() || s.opencode.requests.values()
            .any(|r| matches!(r.tag.as_str(), "session_get" | "session_new")))
    }

    fn send_opencode_carried(&self, rt: &mut TabRuntime, text: String, images: Vec<(String, String)>,
        seq: u64, original: provider_authority::OperationContext,
    ) -> Result<()> {
        anyhow::ensure!(!self.opencode_opening(rt), "OpenCode opening retains its original stash; successor must queue");
        self.with_provider_state(rt, |s| s.opencode.carried = true);
        let Engine::OpenCode(engine) = &rt.engine else { bail!("OpenCode association missing") };
        let opening = !engine.ready;
        let entry = index::get(&rt.session_id)?;
        let settings = Settings::of(entry.tab(&rt.tab_id).context("OpenCode configuration tab missing")?);
        let mut configuration = Vec::new();
        for setting in ["model", "mode"] {
            let existing = self.with_provider_state(rt, |s| s.settings.get(setting).cloned());
            if let Some(existing) = existing { configuration.push(existing); }
            else if opening || settings.collaboration_requests().contains_key(setting)
                || (setting == "model" && settings.requested_model.is_some())
                || (setting == "mode" && settings.requested_permission_mode.is_some()) {
                let permit = settings.collaboration_requests().get(setting).and_then(|id| rt.collaboration_settings.get(id)).cloned();
                let context = self.capture_acp_setting(rt, &settings, setting, permit.as_ref())?;
                self.stage_opencode_setting(rt, context.clone());
                configuration.push(context);
            }
        }
        if !configuration.is_empty() {
            self.with_provider_state(rt, |s| {
                s.opencode.preparing = Some((seq, original.clone()));
                s.operations.insert(original.operation_id().into(), original.clone());
            });
            let manager = self.clone(); let runtime = rt.me.clone();
            std::thread::spawn(move || {
                let Some(runtime) = runtime.upgrade() else { original.withdraw(); return };
                manager.prepare_opencode_prompt(&runtime, text, images, seq, original, configuration);
            });
            return Ok(());
        }
        let Engine::OpenCode(engine) = &mut rt.engine else { bail!("OpenCode association missing") };
        engine.set_prompt_seq(seq);
        let actions = engine.prompt(text, images);
        let envelopes = self.carry_opencode_actions(rt, &original, Some(seq), actions)?;
        // All child contexts exist before the ingress parent is sealed.
        original.seal_origin();
        self.stage_opencode_actions(rt, envelopes, Some(seq));
        Ok(())
    }

    /// Called only by admitted ingress or INSIDE the one whole-response batch.
    /// The adapter's pure opening/stash/fallback state never creates authority.
    fn carry_opencode_actions(&self, rt: &mut TabRuntime, parent: &provider_authority::OperationContext,
        seq: Option<u64>, actions: Vec<Action>,
    ) -> Result<Vec<crate::harness::ProviderAction>> {
        use provider_authority::Correlation;
        let mut staged = Vec::new();
        for action in actions {
            if let Action::Http { tag, .. } = &action {
                let request = uuid::Uuid::new_v4().to_string();
                let correlation = match tag.as_str() {
                    "session_get" | "session_new" => Correlation::Opening { request, parent_operation: parent.operation_id().into() },
                    "prompt" => Correlation::Prompt { seq: seq.context("OpenCode prompt lost its original sequence")?, request },
                    "abort" if matches!(parent.correlation(), Correlation::Control { kind, .. } if kind == "interrupt") => parent.correlation().clone(),
                    _ if matches!(parent.correlation(), Correlation::Approval { ask_id, .. } if tag == &format!("permission:{ask_id}")) => parent.correlation().clone(),
                    _ => bail!("OpenCode mutation has no exact original parent"),
                };
                let context = parent.derive_follow_on(correlation)?;
                staged.push(crate::harness::ProviderAction { context, action });
            } else {
                // Read-only effects are part of the same admitted batch. No
                // reusable per-action callback token or TLS recapture.
                anyhow::ensure!(!matches!(action, Action::Write(_) | Action::AcpPrompt(_) | Action::AcpMode { .. } | Action::AcpModelRefused { .. }),
                    "OpenCode produced an uncarried mutation");
                self.apply_actions(rt, vec![action]);
            }
        }
        Ok(staged)
    }

    fn stage_opencode_actions(&self, rt: &mut TabRuntime, actions: Vec<crate::harness::ProviderAction>, seq: Option<u64>) {
        for envelope in actions {
            let Action::Http { generation, tag, .. } = &envelope.action else { envelope.context.withdraw(); continue };
            let ask_incarnation = if let provider_authority::Correlation::Approval { ask_id, .. } = envelope.context.correlation() {
                self.with_provider_state(rt, |s| s.opencode.asks.get(ask_id).map(|(_, incarnation)| incarnation.clone()))
            } else { None };
            let record = OpenCodeRequest { context: envelope.context.clone(), generation: *generation, tag: tag.clone(), prompt_seq: seq, ask_incarnation };
            self.with_provider_state(rt, |s| {
                s.opencode.carried = true;
                if let provider_authority::Correlation::Approval { ask_id, .. } = record.context.correlation() {
                    if let Some(old) = s.opencode.answers.insert(ask_id.clone(), record.context.operation_id().into()) {
                        if let Some(old) = s.opencode.requests.get(&old) { old.context.withdraw(); }
                    }
                }
                s.operations.insert(record.context.operation_id().into(), record.context.clone());
                s.opencode.requests.insert(record.context.operation_id().into(), record);
            });
            let manager = self.clone(); let runtime = rt.me.clone(); let child = rt.child.clone();
            std::thread::spawn(move || {
                let (Some(runtime), Some(child)) = (runtime.upgrade(), child) else { envelope.context.withdraw(); return };
                manager.write_opencode_carried(&runtime, &child, envelope);
            });
        }
    }

    fn opencode_request_current(&self, rt: &TabRuntime, context: &provider_authority::OperationContext,
        generation: u64, tag: &str,
    ) -> bool {
        let Engine::OpenCode(engine) = &rt.engine else { return false };
        if engine.generation() != generation { return false; }
        self.with_provider_state(rt, |s| {
            let exact = s.opencode.requests.get(context.operation_id()).is_some_and(|r|
                r.generation == generation && r.tag == tag && r.context.correlation() == context.correlation());
            exact && match context.correlation() {
                provider_authority::Correlation::Approval { ask_id, .. } =>
                    s.opencode.answers.get(ask_id).is_some_and(|id| id == context.operation_id()) && engine.answer_pending(ask_id)
                        && s.opencode.requests.get(context.operation_id()).is_some_and(|r| s.opencode.asks.get(ask_id)
                            .is_some_and(|(_, live)| r.ask_incarnation.as_ref() == Some(live))),
                _ => true,
            }
        })
    }

    fn write_opencode_carried(&self, runtime: &Arc<Mutex<TabRuntime>>, child: &Arc<LiveChild>,
        envelope: crate::harness::ProviderAction,
    ) {
        use provider_authority::{Attempt, StreamOutcome};
        use opencode::{PhysicalOutcome, WriteAdmission};
        let context = envelope.context.clone();
        let Ok(mut reservation) = context.reserve_stream() else { return };
        let Ok(http) = opencode::NativeHttp::from_envelope(envelope) else { return };
        // One reservation for the entire exchange. Neither closure retains
        // policy/session/sender/runtime guards between calls or during reads.
        let mut final_write = |original: &provider_authority::OperationContext, generation: u64,
            syscall: &mut dyn FnMut() -> std::io::Result<usize>| {
            #[cfg(test)]
            self.opencode_write_barrier(runtime, original);
            let mut result = WriteAdmission::Refused;
            let admission = self.with_provider_admission(runtime, original, |rt| {
                let binding = self.provider_binding(rt).context("OpenCode association retired")?;
                let record = self.with_provider_state(rt, |s| s.opencode.requests.get(original.operation_id()).cloned())
                    .context("OpenCode request retired")?;
                anyhow::ensure!(original.operation_id() == context.operation_id() && binding.matches_child(child)
                    && self.opencode_request_current(rt, original, generation, &record.tag), "OpenCode exact child/generation/request retired");
                let witness = Self::collaboration_witness(rt);
                let (attempt, called) = reservation.try_chunk(&binding, original.correlation(), witness.as_ref(), |_| Ok(()), syscall)?;
                result = match (attempt, called) {
                    (Attempt::Applied, Some(_)) => WriteAdmission::Admitted,
                    (Attempt::Deferred, None) => WriteAdmission::Deferred,
                    _ => WriteAdmission::Refused,
                };
                Ok(attempt)
            });
            if matches!(admission, Ok(Attempt::Deferred)) { WriteAdmission::Deferred } else { result }
        };
        let reply = http.dispatch(Some(&mut final_write), |original, generation| {
            let rt = runtime.lock().unwrap();
            !rt.stopping && rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, child))
                && self.provider_binding(&rt).is_some_and(|live| original.stream_current(&live))
                && self.with_provider_state(&rt, |s| s.opencode.requests.get(original.operation_id())
                    .is_some_and(|r| self.opencode_request_generation(&rt, r, generation)))
        });
        // Do not preempt the reservation with withdraw(). C supplies the exact
        // physical classification; finish exactly once before ANY callback.
        let awaiting = reservation.finish(match &reply.outcome {
            PhysicalOutcome::Refused => StreamOutcome::Refused,
            PhysicalOutcome::Unknown => StreamOutcome::Unknown,
            PhysicalOutcome::Response { .. } => StreamOutcome::Response,
        });
        if awaiting {
            #[cfg(test)] {
                let hook = { let rt = runtime.lock().unwrap(); self.with_provider_state(&rt, |s| s.opencode.before_callbacks.pop_front()) };
                if let Some(hook) = hook { hook(&reply); }
            }
            while let Ok(Attempt::Deferred) = self.opencode_response_batch(runtime, child, &reply) {
                std::thread::sleep(Duration::from_millis(5));
            }
        } else { self.retire_opencode_original(runtime, child, &reply.context, reply.generation, &reply.tag); }
        self.drain_carried_acp_queue(runtime);
    }

    fn opencode_request_generation(&self, rt: &TabRuntime, record: &OpenCodeRequest, generation: u64) -> bool {
        // Cancellation polling only. Physical authority is checked again by
        // the final hook, including original Actor/source/revision and peers.
        record.generation == generation && matches!(&rt.engine, Engine::OpenCode(e) if e.generation() == generation)
    }

    fn opencode_response_batch(&self, runtime: &Arc<Mutex<TabRuntime>>, child: &Arc<LiveChild>,
        reply: &opencode::NativeHttpReply,
    ) -> Result<provider_authority::Attempt> {
        use provider_authority::Attempt;
        let context = &reply.context;
        if context.callback_finished() { return Ok(Attempt::Withdrawn); }
        let opencode::PhysicalOutcome::Response { status, body } = &reply.outcome else { bail!("OpenCode callback requires known response") };
        let line = serde_json::json!({"raccoon_http":{"tag":reply.tag,"status":status,"body":body}}).to_string();
        let mut staged = Vec::new(); let mut seq = None; let mut answered = false;
        let result = self.with_provider_admission(runtime, context, |rt| {
            let binding = self.provider_binding(rt).context("OpenCode callback association retired")?;
            anyhow::ensure!(binding.matches_child(child), "OpenCode callback child replaced");
            if !self.opencode_request_current(rt, context, reply.generation, &reply.tag) { return Ok(Attempt::Withdrawn); }
            let witness = Self::collaboration_witness(rt);
            context.try_callback(&binding, context.correlation(), witness.as_ref(), |_| Ok(()), || {
                seq = self.with_provider_state(rt, |s| s.opencode.requests.get(context.operation_id()).and_then(|r| r.prompt_seq));
                let Engine::OpenCode(engine) = &mut rt.engine else { bail!("OpenCode callback engine retired") };
                let answer = engine.settle_answer(&reply.tag, &line);
                let actions = engine.handle(&line);
                // Resume failure may produce session_new ONLY from a real
                // complete response, under the same original callback parent.
                staged = self.carry_opencode_actions(rt, context, seq, actions)?;
                if let Some((request, allow)) = answer {
                    self.permission_delivered(rt, &request, allow);
                    answered = true;
                }
                rt.last_activity = Instant::now();
                rt.incidents.progress("agent_output");
                self.stall_disproved(rt);
                Ok(())
            })
        });
        match result {
            Ok(Attempt::Applied) => {
                let mut rt = runtime.lock().unwrap();
                self.remove_opencode_request(&rt, context);
                // All original children exist; parent is Delivered; callback
                // guards are gone before a physical child is scheduled.
                if !rt.stopping && rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, child))
                    && self.provider_binding(&rt).is_some_and(|live| context.association_current(&live)) {
                    self.stage_opencode_actions(&mut rt, staged, seq);
                } else { for envelope in staged { envelope.context.withdraw(); } }
                drop(rt);
                if answered { let (session, tab) = context.destination(); self.observer.answered(session, tab); }
                Ok(Attempt::Applied)
            },
            Ok(Attempt::Deferred) => Ok(Attempt::Deferred),
            _ => {
                if !context.callback_finished() {
                    self.retire_opencode_original(runtime, child, context, reply.generation, &reply.tag);
                }
                Ok(Attempt::Withdrawn)
            },
        }
    }

    fn remove_opencode_request(&self, rt: &TabRuntime, context: &provider_authority::OperationContext) {
        self.with_provider_state(rt, |s| {
            s.operations.remove(context.operation_id());
            s.opencode.requests.remove(context.operation_id());
            if let provider_authority::Correlation::Approval { ask_id, .. } = context.correlation() {
                if s.opencode.answers.get(ask_id).is_some_and(|id| id == context.operation_id()) { s.opencode.answers.remove(ask_id); }
            }
        });
    }

    fn retire_opencode_original(&self, runtime: &Arc<Mutex<TabRuntime>>, child: &Arc<LiveChild>,
        context: &provider_authority::OperationContext, generation: u64, tag: &str,
    ) {
        context.withdraw();
        let mut rt = runtime.lock().unwrap();
        let exact = rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, child))
            && self.provider_binding(&rt).is_some_and(|live| context.association_current(&live))
            && self.opencode_request_current(&rt, context, generation, tag);
        self.remove_opencode_request(&rt, context);
        if !exact { return; } // old attempts cannot cancel a new equal tag
        let Engine::OpenCode(engine) = &mut rt.engine else { return };
        let actions = engine.withdraw_prompt(tag);
        self.apply_actions(&mut rt, actions);
    }

    fn answer_opencode_carried(&self, rt: &mut TabRuntime, request: &str, option: &str,
        original: provider_authority::OperationContext,
    ) -> Result<()> {
        let provider_authority::Correlation::Approval { ask_id, provider_request, .. } = original.correlation() else { bail!("OpenCode answer lacks original Approve correlation") };
        anyhow::ensure!(ask_id == request && self.with_provider_state(rt, |s| s.opencode.asks.get(request)
            .is_some_and(|(native, _)| native == provider_request)), "OpenCode original ask replaced");
        // A new answer attempt is independent Approve, never an old Drive or
        // old Allow carrier. Superseding retires only the exact old attempt.
        let old = self.with_provider_state(rt, |s| s.opencode.answers.get(request)
            .and_then(|id| s.opencode.requests.get(id)).cloned());
        if let Some(old) = old {
            old.context.withdraw();
            self.remove_opencode_request(rt, &old.context);
            if let Engine::OpenCode(e) = &mut rt.engine { e.withdraw_prompt(&old.tag); }
        }
        let Engine::OpenCode(engine) = &mut rt.engine else { bail!("OpenCode approval engine retired") };
        let actions = engine.answer(request, option).context("OpenCode permission no longer answerable")?;
        let staged = self.carry_opencode_actions(rt, &original, None, actions)?;
        original.seal_origin();
        self.stage_opencode_actions(rt, staged, None);
        Ok(())
    }

    fn stage_opencode_setting(&self, rt: &mut TabRuntime, context: provider_authority::OperationContext) {
        let manager = self.clone(); let runtime = rt.me.clone();
        std::thread::spawn(move || {
            let Some(runtime) = runtime.upgrade() else { context.withdraw(); return };
            manager.confirm_opencode_setting(&runtime, &context);
        });
    }

    fn confirm_opencode_setting(&self, runtime: &Arc<Mutex<TabRuntime>>, context: &provider_authority::OperationContext) {
        use provider_authority::{Attempt, Correlation};
        let Ok(mut reservation) = context.reserve_stream() else { return };
        loop {
            let result = self.with_provider_admission(runtime, context, |rt| {
                let binding = self.provider_binding(rt).context("OpenCode setting association retired")?;
                let Correlation::Setting { setting, request_id, .. } = context.correlation() else { bail!("OpenCode setting requires Configure identity") };
                anyhow::ensure!(self.carried_opencode(rt) && self.with_provider_state(rt, |s| s.settings.get(setting)
                    .is_some_and(|current| current.operation_id() == context.operation_id())), "OpenCode setting attempt replaced");
                let entry = index::get(&rt.session_id)?;
                let settings = Settings::of(entry.tab(&rt.tab_id).context("OpenCode setting tab missing")?);
                let remote = context.sender().permit().is_some_and(|p| p.collaboration.runtime_policy.is_v2());
                anyhow::ensure!(if remote { settings.collaboration_requests().get(setting) == Some(request_id) }
                    else { !settings.collaboration_requests().contains_key(setting) }, "OpenCode native Configure intent replaced");
                let witness = Self::collaboration_witness(rt);
                let attempt = reservation.try_confirm(&binding, witness.as_ref())?;
                if attempt != Attempt::Applied { return Ok(attempt); }
                // OpenCode has no model/mode RPC. This is the actual no-wire
                // next-prompt snapshot mutation, admitted with Configure.
                let Engine::OpenCode(engine) = &mut rt.engine else { bail!("OpenCode setting engine retired") };
                match setting.as_str() {
                    "model" => engine.model = Some(settings.requested_model.as_ref().unwrap_or(&settings.model).clone()),
                    "mode" => engine.mode = settings.requested_permission_mode.as_ref().unwrap_or(&settings.permission_mode).clone(),
                    _ => bail!("unsupported OpenCode setting"),
                }
                self.settle_acp_setting(rt, context, true, &mut Vec::new())?;
                Ok(attempt)
            });
            if matches!(result, Ok(Attempt::Deferred)) { std::thread::sleep(Duration::from_millis(5)); continue; }
            if !matches!(result, Ok(Attempt::Applied)) { context.withdraw(); }
            return;
        }
    }

    fn on_opencode_event_from(&self, runtime: &Arc<Mutex<TabRuntime>>, child: &Arc<LiveChild>,
        captured: &provider_authority::ProviderBinding, line: &str,
    ) {
        let mut rt = runtime.lock().unwrap();
        if rt.stopping || !rt.child.as_ref().is_some_and(|live| Arc::ptr_eq(live, child))
            || !self.provider_binding(&rt).is_some_and(|live| captured.current(&live)) { return; }
        // No HTTP callbacks may enter through stdout/SSE. Only NativeHttpReply
        // carries exact original identity. Output is association-only and does
        // not borrow the previous remote prompt's Drive authority.
        let Ok(value) = serde_json::from_str::<Value>(line) else { return };
        if value.get("raccoon_http").is_some() { return; }
        let carried = self.carried_opencode(&rt);
        if carried && matches!(&rt.engine, Engine::OpenCode(e) if e.session_id.is_some()
            && value["properties"]["sessionID"].as_str().is_some_and(|sid| Some(sid) != e.session_id.as_deref())) { return; }
        if carried && matches!(value["type"].as_str(), Some("permission.asked" | "permission.updated" | "permission.replied")) {
            let properties = &value["properties"];
            let native = properties["id"].as_str().or_else(|| properties["permissionID"].as_str()).or_else(|| properties["requestID"].as_str());
            let mine = matches!(&rt.engine, Engine::OpenCode(e) if e.session_id.is_none()
                || properties["sessionID"].is_null() || properties["sessionID"].as_str() == e.session_id.as_deref());
            if let Some(native) = native.filter(|_| mine) {
                let ask = format!("oc:{native}");
                let old = self.with_provider_state(&rt, |s| {
                    if value["type"] == "permission.replied" { s.opencode.asks.remove(&ask); }
                    else { s.opencode.asks.insert(ask.clone(), (native.into(), uuid::Uuid::new_v4().to_string())); }
                    s.opencode.answers.get(&ask).and_then(|id| s.opencode.requests.get(id)).cloned()
                });
                if let Some(old) = old {
                    old.context.withdraw(); self.remove_opencode_request(&rt, &old.context);
                    if let Engine::OpenCode(e) = &mut rt.engine { e.withdraw_prompt(&old.tag); }
                }
            }
        }
        let Engine::OpenCode(engine) = &mut rt.engine else { return };
        let actions = engine.handle(line).into_iter().filter(|a| !carried || !matches!(a,
            Action::Http { .. } | Action::Write(_) | Action::AcpPrompt(_) | Action::AcpMode { .. }
            | Action::AcpModelRefused { .. } | Action::Emit(Payload::ProviderSettings { .. }))).collect();
        self.apply_actions(&mut rt, actions);
    }
}

#[cfg(test)]
impl SessionManager {
    fn opencode_write_barrier(&self, runtime: &Arc<Mutex<TabRuntime>>, _: &provider_authority::OperationContext) {
        let hook = {
            let rt = runtime.lock().unwrap();
            self.with_provider_state(&rt, |s| s.opencode.before_writes.pop_front())
        };
        // Test barriers, like capacity waits, never retain owner guards.
        if let Some(hook) = hook { hook(); }
    }
}

#[cfg(test)]
#[path = "session_opencode_owner_tests.rs"]
mod provider_integration_e;

impl SessionManager {
    fn prepare_opencode_prompt(&self, runtime: &Arc<Mutex<TabRuntime>>, text: String, images: Vec<(String, String)>,
        seq: u64, original: provider_authority::OperationContext,
        configuration: Vec<provider_authority::OperationContext>,
    ) {
        use provider_authority::Attempt;
        let mut staged = Vec::new();
        let admitted = loop {
            // Configure workers confirm their own exact intents. No original
            // Drive is upgraded to Configure, and no owner guard spans waiting.
            let current = {
                let rt = runtime.lock().unwrap();
                !rt.stopping && self.provider_binding(&rt).is_some_and(|live| original.association_current(&live))
                    && self.with_provider_state(&rt, |s| s.opencode.preparing.as_ref()
                        .is_some_and(|(_, pending)| pending.operation_id() == original.operation_id()))
            };
            if !current || original.retired() || configuration.iter().any(|c| c.retired()) { break false; }
            if !configuration.iter().all(|c| c.callback_finished()) {
                std::thread::sleep(Duration::from_millis(5)); continue;
            }
            let result = self.with_provider_admission(runtime, &original, |rt| {
                let binding = self.provider_binding(rt).context("OpenCode prepared association retired")?;
                anyhow::ensure!(original.association_current(&binding) && !original.retired()
                    && self.with_provider_state(rt, |s| s.opencode.preparing.as_ref()
                        .is_some_and(|(_, pending)| pending.operation_id() == original.operation_id())), "OpenCode prepared prompt retired");
                original.sender().check(provider_authority::RequiredAction::Drive, Self::collaboration_witness(rt).as_ref())?;
                let pending = self.with_provider_state(rt, |s| s.settings.values().cloned().collect::<Vec<_>>());
                anyhow::ensure!(!pending.iter().any(|c| c.retired()), "OpenCode pending Configure retired");
                if !pending.is_empty() { return Ok(Attempt::Deferred); }
                let Engine::OpenCode(engine) = &mut rt.engine else { bail!("OpenCode prepared engine retired") };
                engine.set_prompt_seq(seq);
                let actions = engine.prompt(text.clone(), images.clone());
                staged = self.carry_opencode_actions(rt, &original, Some(seq), actions)?;
                original.seal_origin();
                // Retain preparing until physical children are registered, so
                // another queued item cannot occupy this opening's stash.
                Ok(Attempt::Applied)
            });
            if matches!(result, Ok(Attempt::Deferred)) { std::thread::sleep(Duration::from_millis(5)); continue; }
            break matches!(result, Ok(Attempt::Applied));
        };
        let mut rt = runtime.lock().unwrap();
        let exact = self.with_provider_state(&rt, |s| s.opencode.preparing.as_ref()
            .is_some_and(|(_, pending)| pending.operation_id() == original.operation_id()));
        if exact {
            self.with_provider_state(&rt, |s| { s.opencode.preparing = None; s.operations.remove(original.operation_id()); });
            if admitted && !rt.stopping && self.provider_binding(&rt).is_some_and(|live| original.association_current(&live)) {
                self.stage_opencode_actions(&mut rt, staged, Some(seq));
            } else {
                for child in staged { child.context.withdraw(); }
                original.withdraw();
                self.prompt_withdrawn(&mut rt, seq, None);
                rt.turn_open = false;
            }
        } else { for child in staged { child.context.withdraw(); } }
        drop(rt);
        self.drain_carried_acp_queue(runtime);
    }
}
