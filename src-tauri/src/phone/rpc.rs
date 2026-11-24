//! The deliberately small paired-device application RPC.
//!
//! Hosted services only move ciphertext. This module resolves public session
//! and tab identifiers against local state on every operation, and it never
//! returns a checkout path, pane id, or process handle to the phone.

use crate::paths::Canonical;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::local_runtime::mobile::model::{AccountMirror, DeviceEntry, DeviceProvenance, DeviceScope};
use super::send_ids::{Reply, SendIds, SendKey, ID_REUSED, STILL_SENDING};
use crate::local_runtime::mobile::Repeat;
use super::latest_worker::LatestWorker;
use super::sync_cache::{Reader, Stopped, SyncCache, Verified, Wanted, WANTED_EVERY};
use super::wire::{megabytes, ReplyLimits, Transport, Wire};
use super::PhoneHost;
use crate::events::{AgentEvent, Payload};
use crate::store::index::{self, SessionEntry, TabEntry};
use crate::sink::{EventSink, ListenerId};
use crate::{store, summaries};

/// The account this computer's phones were paired under (`account.json`),
/// as the window's pairing registry keeps it.
fn account_mirror() -> Result<Option<AccountMirror>> {
    store::read_json(&store::root()?.join("account.json"))
}

const NOTES_LIMIT: usize = 1_000;
const NOTE_BYTES_LIMIT: usize = 16 * 1024;
const INPUT_BYTES_LIMIT: usize = 64 * 1024;
const ATTACHMENT_BYTES_LIMIT: usize = 5 * 1024 * 1024;
const ATTACHMENT_COUNT_LIMIT: usize = 8;
const NOTIFICATION_LIMIT: usize = 512;
const TAIL_EVENT_LIMIT: usize = 5_000;
// What one encrypted text frame carries on a direct connection: 6 MiB for the
// entire serialized RPC response, including its envelope. No transcript reply
// is larger on any transport; on Relay a page is held to one Relay frame.
const TAIL_RESPONSE_BYTES_LIMIT: usize = Transport::Direct.text_plaintext_limit();
/// How long a connection waits for the runtime to register or check it.
const RUNTIME_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Runtime calls block on a local socket for up to two minutes. They run on
/// the blocking pool, so a stalled runtime cannot hold the async workers that
/// Relay's control channel also runs on (#666, #661).
pub(crate) async fn off_runtime<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(work).await.context("a paired-device runtime call stopped")?
}

/// `off_runtime` for a call that may be abandoned: one that changes nothing,
/// or whose result undoes itself when dropped, as a `MobileConnection` does.
async fn off_runtime_within<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::time::timeout(RUNTIME_CALL_TIMEOUT, off_runtime(work)).await.map_err(|_| {
        anyhow!(super::RuntimeUnanswered)
            .context(format!("The local runtime did not answer within {} s.", RUNTIME_CALL_TIMEOUT.as_secs()))
    })?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileNotification {
    seq: u64,
    epoch: String,
    title: String,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_id: Option<String>,
    /// What the notice is about (#990), for a phone that chooses which it is sent.
    kind: NoticeKind,
    /// The session's title as the Mac shows it, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_title: Option<String>,
    /// For a `question` the phone can answer from the notice alone: one
    /// question, one answer from its options. `body` is then the question
    /// exactly, the key `questions.respond` takes it by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    question: Option<QuestionNotice>,
    /// For an `approval`: what `permission.respond` takes besides the option.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<ApprovalNotice>,
    /// For a `bot_question`. Its `sessionId` and `tabId` name the bot's home
    /// chat, so a phone that does not know the kind opens that chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bot_question: Option<BotQuestionNotice>,
}

/// The kinds of notice a phone can be sent (#990). A phone's filter names
/// them by these words; one it names that is not here matches nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum NoticeKind {
    Question,
    Approval,
    Finished,
    Failed,
    UsageLimit,
    PrChecksFailed,
    PrMerged,
    /// A bot asks its owner a question on one of its work items (PRO-479).
    BotQuestion,
}

impl NoticeKind {
    fn name(self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Approval => "approval",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::UsageLimit => "usage_limit",
            Self::PrChecksFailed => "pr_checks_failed",
            Self::PrMerged => "pr_merged",
            Self::BotQuestion => "bot_question",
        }
    }

    /// Whether the notice waits on the person: what `needsMe` sends.
    fn needs_me(self) -> bool {
        matches!(self, Self::Question | Self::Approval | Self::BotQuestion)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionNotice {
    request_id: String,
    options: Vec<QuestionNoticeOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionNoticeOption {
    label: String,
}

/// The option ids an `approval` notice's Allow and Deny answer with
/// (`permission.respond`); a request that offers other ids has no `approval`.
const APPROVAL_ALLOW: &str = "allow";
const APPROVAL_DENY: &str = "deny";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalNotice {
    request_id: String,
}

/// For a `bot_question` (PRO-479): which question of which bot's item, and its
/// answers, so the phone opens it as a sheet or answers it from the notice
/// with `bots.answer`, the way the app answers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotQuestionNotice {
    bot_id: String,
    number: u64,
    /// The question's id, or when it was asked for one an older build asked: `bots.answer`'s `question`.
    question: String,
    answers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recommended: Option<usize>,
}

/// The notices a phone asked for (#990), held only by the subscription that
/// asked: the Mac keeps nothing of a phone's choices. No filter sends every
/// notice, as before there were filters.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotificationFilter {
    /// The kinds sent for a session that passes `sessions`; absent, every kind.
    #[serde(default)]
    kinds: Option<Vec<String>>,
    /// Absent, every session.
    #[serde(default)]
    sessions: Option<SessionScope>,
    /// One session's own choice, over `kinds` and `sessions` both.
    #[serde(default)]
    overrides: HashMap<String, SessionOverride>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "scope", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum SessionScope {
    All,
    Only { ids: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SessionOverride {
    /// Only what waits on the person: questions and approvals.
    NeedsMe,
    /// Every kind, whatever `kinds` and `sessions` say.
    Everything,
    /// Nothing.
    Mute,
}

impl NotificationFilter {
    fn admits(&self, notification: &MobileNotification) -> bool {
        let session = notification.session_id.as_deref();
        match session.and_then(|id| self.overrides.get(id)) {
            Some(SessionOverride::Mute) => return false,
            Some(SessionOverride::Everything) => return true,
            Some(SessionOverride::NeedsMe) => return notification.kind.needs_me(),
            None => {}
        }
        let in_scope = match &self.sessions {
            // A bot's question is the bot's, not one session's (PRO-479).
            _ if notification.kind == NoticeKind::BotQuestion => true,
            None | Some(SessionScope::All) => true,
            Some(SessionScope::Only { ids }) => session.is_some_and(|id| ids.iter().any(|only| only == id)),
        };
        in_scope && self.kinds.as_ref().is_none_or(|kinds| kinds.iter().any(|kind| kind == notification.kind.name()))
    }
}

fn admitted(filter: Option<&NotificationFilter>, notification: &MobileNotification) -> bool {
    filter.is_none_or(|filter| filter.admits(notification))
}

/// What a tab's open turn has met that its end is told by (#990).
#[derive(Debug, Default)]
struct TurnNotes {
    /// Its usage limit was noticed: reported again, it is not news again.
    limited: bool,
    /// A failure met before the turn ended, which an aborted end is down to.
    failure: Option<crate::recovery::RecoveryKind>,
    /// `failure` is a non-fatal error's: the agent's carrying on after it
    /// (`carries_on`) shows the turn got past it, and clears it.
    passing: bool,
}

/// What an agent does only while its turn goes on: after a non-fatal error,
/// the error did not end it.
fn carries_on(payload: &Payload) -> bool {
    matches!(payload, Payload::AssistantText { .. } | Payload::Reasoning { .. } | Payload::ToolCallStarted { .. }
        | Payload::ToolCallCompleted { .. } | Payload::FileEdits { .. } | Payload::ModelRequestStarted)
}

/// The filter a connection's latest `notifications.subscribe` named, and that
/// subscription's id: `notifications.event`, sent to every connection, is
/// held to it too. Unsubscribing that subscription clears it.
type ConnectionFilter = Arc<Mutex<Option<(String, NotificationFilter)>>>;

struct MobileClient {
    sender: mpsc::Sender<Value>,
    overflowed: Arc<std::sync::atomic::AtomicBool>,
    filter: ConnectionFilter,
    invalidations: Arc<super::Invalidations>,
}

pub(crate) struct MobileRuntime {
    sink: OnceLock<Arc<dyn EventSink>>,
    clients: Mutex<HashMap<String, MobileClient>>,
    notifications: Mutex<VecDeque<MobileNotification>>,
    notification_epoch: String,
    notification_seq: std::sync::atomic::AtomicU64,
    /// Questions and permission requests already noticed, by `session/tab`
    /// and request id: an ask published again (a reconciliation) is not news
    /// again. Ids are only a tab's own (ACP's `acp:{n}` and Codex's bare
    /// numbers count from one in each agent process), so a tab's are
    /// forgotten when its next turn starts: a restarted agent asks anew.
    asked: Mutex<VecDeque<(String, String)>>,
    /// What each tab's turn has met since it began, by `session/tab`.
    turns: Mutex<HashMap<String, TurnNotes>>,
    /// Pipeline news already sent, by `engine::PhoneNotice::key`. Held in
    /// memory only: news from before `started` is not sent at all, as an
    /// earlier run of the app may have sent it.
    pipeline_notices: Mutex<VecDeque<String>>,
    /// Bots' questions already noticed, by bot, item and question (PRO-479).
    /// Only questions asked since `started` are noticed at all.
    bot_notices: Mutex<VecDeque<String>>,
    /// Whether Bots was on when last looked at: a change tells phones to read
    /// their capabilities again.
    bots_on: std::sync::atomic::AtomicBool,
    started: chrono::DateTime<Utc>,
    notes: Mutex<()>,
    /// Shared by every connection: the retry of a send whose reply was lost
    /// comes over the connection that replaced the one that dropped (#675).
    send_ids: SendIds,
    /// The desktop's own Codex model list, so a phone choosing a model for a
    /// new session sees what the new-session view offers.
    codex_models: OnceLock<Arc<crate::harness::codex::models::Cache>>,
}

impl MobileRuntime {
    pub(crate) fn new() -> Self {
        Self {
            sink: OnceLock::new(),
            clients: Mutex::new(HashMap::new()),
            notifications: Mutex::new(VecDeque::new()),
            notification_epoch: Uuid::new_v4().to_string(),
            notification_seq: std::sync::atomic::AtomicU64::new(0),
            asked: Mutex::new(VecDeque::new()),
            turns: Mutex::new(HashMap::new()),
            pipeline_notices: Mutex::new(VecDeque::new()),
            bot_notices: Mutex::new(VecDeque::new()),
            bots_on: std::sync::atomic::AtomicBool::new(crate::bots::enabled()),
            started: Utc::now(),
            notes: Mutex::new(()),
            send_ids: SendIds::new(),
            codex_models: OnceLock::new(),
        }
    }

    pub(crate) fn attach_models(&self, cache: Arc<crate::harness::codex::models::Cache>) {
        let _ = self.codex_models.set(cache);
    }

    pub(crate) fn configure(self: &Arc<Self>, sink: Arc<dyn EventSink>) -> Result<()> {
        self.sink.set(sink.clone()).map_err(|_| anyhow!("mobile runtime was already configured"))?;
        // The sidebar's order and the cloud pins: what the phone's Pinned section lists (#1403).
        for event in ["tab_status", "session_created", "session_updated", crate::session_ops::SESSION_DELETED_EVENT, "sidebar_order_changed", store::cloud_pins::CHANGED] {
            let runtime = Arc::downgrade(self);
            sink.listen(event, Box::new(move |_| {
                if let Some(runtime) = runtime.upgrade() { runtime.broadcast_sessions_changed(); }
            }));
        }
        // The bots (PRO-479): a phone reads them again when they or a list
        // change, and is told of each question newly asked of the owner.
        for event in ["bots_changed", crate::bots::items::EVENT] {
            let runtime = Arc::downgrade(self);
            sink.listen(event, Box::new(move |payload| {
                let Some(runtime) = runtime.upgrade() else { return };
                runtime.invalidate(super::Invalidation::Bots);
                if event != crate::bots::items::EVENT { return; }
                let Some(bot) = serde_json::from_str::<Value>(payload).ok().and_then(|payload| payload["botId"].as_str().map(str::to_owned)) else { return };
                // Off the writer's thread: it announces the change under its list's lock.
                let weak = Arc::downgrade(&runtime);
                let spawned = std::thread::Builder::new().name("bot-notices".into()).spawn(move || {
                    let Some(runtime) = weak.upgrade() else { return };
                    for notification in runtime.bot_notifications(&bot) {
                        runtime.publish(runtime.sink.get().map(|sink| &**sink), notification);
                    }
                });
                if let Err(error) = spawned { log::warn!("notice a bot's questions: {error}"); }
            }));
        }
        // Bots switched on or off: what a phone is offered changes with it.
        for event in ["experimental_settings_changed", "settings_file_changed", "bots_changed"] {
            let runtime = Arc::downgrade(self);
            sink.listen(event, Box::new(move |_| {
                if let Some(runtime) = runtime.upgrade() { runtime.watch_bots_switch(crate::bots::enabled()); }
            }));
        }
        // An issue's pipeline, written: its pull request's checks failing, or its merge (#990).
        let runtime = Arc::downgrade(self);
        sink.listen(crate::issue_pipeline::host::CHANGED, Box::new(move |payload| {
            let Some(runtime) = runtime.upgrade() else { return };
            let Ok(pipeline) = serde_json::from_str::<crate::issue_pipeline::Pipeline>(payload) else { return };
            // Only a merge or a stop can be news: every other write reads no session.
            use crate::issue_pipeline::State;
            if pipeline.pr.is_none() || !matches!(pipeline.state, State::Merged | State::NeedsYou) { return; }
            let author = index::get(&pipeline.author.session_id).ok().map(|session| session.title);
            let Some(notice) = crate::issue_pipeline::engine::phone_notice(&pipeline, author.as_deref(), Utc::now()) else { return };
            if let Some(notification) = runtime.pipeline_notification(notice, author) {
                runtime.publish(runtime.sink.get().map(|sink| &**sink), notification);
            }
        }));
        Ok(())
    }

    fn register_client(&self, id: &str, outbound: mpsc::Sender<Value>, overflowed: Arc<std::sync::atomic::AtomicBool>, filter: ConnectionFilter, invalidations: Arc<super::Invalidations>) {
        self.clients.lock().unwrap().insert(id.into(), MobileClient { sender:outbound, overflowed, filter, invalidations });
    }

    fn unregister_client(&self, id: &str) {
        self.clients.lock().unwrap().remove(id);
    }

    fn broadcast(&self, value: Value) {
        self.clients
            .lock()
            .unwrap()
            .retain(|_, client| {
                if client.sender.try_send(value.clone()).is_ok() { true } else {
                    client.overflowed.store(true,std::sync::atomic::Ordering::SeqCst);
                    false
                }
            });
    }

    /// `notifications.event` to each connection whose subscription's filter
    /// admits it; to every connection that named none, as before filters.
    fn broadcast_notification(&self, notification: &MobileNotification) {
        let value = json!({ "method": "notifications.event", "params": notification });
        self.clients.lock().unwrap().retain(|_, client| {
            if !admitted(client.filter.lock().unwrap().as_ref().map(|(_, filter)| filter), notification) {
                return true;
            }
            if client.sender.try_send(value.clone()).is_ok() { true } else {
                client.overflowed.store(true, std::sync::atomic::Ordering::SeqCst);
                false
            }
        });
    }

    /// Every connection is told once, however many come before it reads it (#1282).
    fn invalidate(&self, which: super::Invalidation) {
        self.clients.lock().unwrap().retain(|_, client| {
            if client.sender.is_closed() { return false; }
            client.invalidations.raise(which);
            true
        });
    }

    pub(crate) fn broadcast_sessions_changed(&self) {
        self.invalidate(super::Invalidation::Sessions);
    }

    pub(crate) fn broadcast_settings_changed(&self) {
        self.invalidate(super::Invalidation::Settings);
    }

    /// The desktop attached to a runtime: what each phone may be offered
    /// comes from it (#730). A connection admitted by the attachment it
    /// replaced checks that attachment before it sends this, finds it gone
    /// and closes, so its phone connects again and asks afresh; one admitted
    /// by this attachment passes it on, and its phone asks again.
    pub(crate) fn broadcast_capabilities_changed(&self) {
        self.invalidate(super::Invalidation::Capabilities);
    }

    pub(crate) fn capture_agent_event(&self, manager: &PhoneHost, payload: &str) {
        let Ok(event) = serde_json::from_str::<AgentEvent>(payload) else { return };
        self.broadcast(json!({ "method": "session.event", "params": { "event": event } }));
        self.broadcast_sessions_changed();
        let Some(notification) = self.agent_notification(&event, || index::get(&event.session_id).ok().map(|session| session.title)) else { return };
        self.publish(manager.sink().map(|sink| &**sink), notification);
    }

    fn next_seq(&self) -> u64 {
        self.notification_seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    fn notification(&self, kind: NoticeKind, title: String, body: String, session_id: &str, tab_id: &str, session_title: Option<String>) -> MobileNotification {
        MobileNotification {
            seq: self.next_seq(),
            epoch: self.notification_epoch.clone(),
            title,
            body,
            session_id: Some(session_id.to_string()),
            tab_id: Some(tab_id.to_string()),
            kind,
            session_title,
            question: None,
            approval: None,
            bot_question: None,
        }
    }

    /// The notice an agent event makes, if it makes one (#990). `title` reads
    /// the session's title, only for an event that makes a notice.
    fn agent_notification(&self, event: &AgentEvent, title: impl FnOnce() -> Option<String>) -> Option<MobileNotification> {
        let tab_key = format!("{}/{}", event.session_id, event.tab_id);
        let (kind, body, question, approval) = match &event.payload {
            Payload::TurnStarted { .. } => {
                self.turns.lock().unwrap().remove(&tab_key);
                self.asked.lock().unwrap().retain(|(tab, _)| *tab != tab_key);
                return None;
            }
            Payload::QuestionsAsked { request_id, questions, .. } => {
                if !self.first_ask(&tab_key, request_id) { return None; }
                let body = match questions.as_slice() {
                    [] => "An agent has a question for you.".to_string(),
                    [one] => collapse_notification_text(&one.question),
                    [first, rest @ ..] => collapse_notification_text(&format!("{} (and {} more)", first.question, rest.len())),
                };
                // Answerable from the notice: one question, one of its options,
                // and the body is its text exactly, which is the answer's key.
                let question = match questions.as_slice() {
                    [one] if !one.multi_select && !one.options.is_empty() && body == one.question => Some(QuestionNotice {
                        request_id: request_id.clone(),
                        options: one.options.iter().map(|option| QuestionNoticeOption { label: option.label.clone() }).collect(),
                    }),
                    _ => None,
                };
                (NoticeKind::Question, body, question, None)
            }
            Payload::PermissionRequested { request_id, tool_name, input, title, description, options, .. } => {
                if !self.first_ask(&tab_key, request_id) { return None; }
                // A command says what is asked in its own words; anything else, the request's title.
                let command = input.get("command").and_then(Value::as_str).map(str::trim).filter(|command| !command.is_empty());
                let shown = command.map(|command| format!("Run: {command}"));
                let asked = shown.as_deref().or(title.as_deref()).or(description.as_deref()).map(collapse_notification_text).filter(|text| !text.is_empty());
                let body = asked.unwrap_or_else(|| collapse_notification_text(&format!("{tool_name} wants permission to run.")));
                // Answerable from the notice's Allow and Deny only when the
                // notice shows all of what is allowed: the command, whole and
                // unchanged (not cut short, not folded onto one line). Anything
                // else is answered in the session, where the card shows it all.
                // The phone sends `allow` or `deny`: a request offering both by those ids.
                let offers = |id: &str, kind: crate::events::PermissionOptionKind| options.iter().any(|option| option.id == id && option.kind == kind);
                let answerable = shown.as_deref() == Some(body.as_str())
                    && offers(APPROVAL_ALLOW, crate::events::PermissionOptionKind::AllowOnce)
                    && offers(APPROVAL_DENY, crate::events::PermissionOptionKind::Deny);
                let approval = answerable.then(|| ApprovalNotice { request_id: request_id.clone() });
                (NoticeKind::Approval, body, None, approval)
            }
            Payload::GoalUpdated { goal } if goal.status != crate::events::GoalStatus::UsageLimited => {
                if let Some(notes) = self.turns.lock().unwrap().get_mut(&tab_key) { notes.limited = false; }
                return None;
            }
            // A goal's snapshot is published again as the chat reopens: the
            // limit is news once until the tab's next turn, or a goal that
            // moved on, as is a provider's rejection reported again.
            Payload::GoalUpdated { .. } | Payload::RateLimited { .. } => {
                let rejected = matches!(&event.payload, Payload::RateLimited { status, .. } if status.as_deref() == Some("rejected"));
                if matches!(&event.payload, Payload::RateLimited { .. }) && !rejected { return None; }
                let mut turns = self.turns.lock().unwrap();
                let notes = turns.entry(tab_key).or_default();
                if rejected { (notes.failure, notes.passing) = (Some(crate::recovery::RecoveryKind::UsageLimit), false); }
                if std::mem::replace(&mut notes.limited, true) { return None; }
                (NoticeKind::UsageLimit, crate::recovery::RecoveryKind::UsageLimit.message().to_string(), None, None)
            }
            Payload::TurnCompleted { status, final_text, .. } => {
                let met = {
                    let mut turns = self.turns.lock().unwrap();
                    let met = turns.get_mut(&tab_key).and_then(|notes| notes.failure.take());
                    // A noticed limit is kept until the next turn; nothing else outlives this one.
                    if turns.get(&tab_key).is_some_and(|notes| !notes.limited) { turns.remove(&tab_key); }
                    met
                };
                // An abort after an error, a lapsed retry or a refused request
                // is that failure's; one with none was a person stopping it.
                let failure = crate::recovery::failure(&event.payload)
                    .or(met.filter(|_| *status == crate::events::TurnStatus::Aborted));
                let text = final_text.as_deref().map(collapse_notification_text).filter(|text| !text.is_empty());
                match failure {
                    Some(failure) => (NoticeKind::Failed, text.unwrap_or_else(|| failure.message().to_string()), None, None),
                    // Ended well, or stopped by a person: finished, as every
                    // turn's end was before notices had kinds.
                    None => (NoticeKind::Finished, text.unwrap_or_else(|| crate::platform_profile::localize("An agent turn finished on your Mac.")), None, None),
                }
            }
            // An error mid-turn is no notice of its own: the turn it ends says
            // so. A non-fatal one only if nothing the agent did followed it.
            payload if crate::recovery::failure(payload).is_some() => {
                let mut turns = self.turns.lock().unwrap();
                let notes = turns.entry(tab_key).or_default();
                notes.failure = crate::recovery::failure(payload);
                notes.passing = matches!(payload, Payload::Error { fatal: false, .. });
                return None;
            }
            payload if carries_on(payload) => {
                if let Some(notes) = self.turns.lock().unwrap().get_mut(&tab_key) {
                    if notes.passing { (notes.failure, notes.passing) = (None, false); }
                }
                return None;
            }
            _ => return None,
        };
        let session_title = title().filter(|title| !title.trim().is_empty());
        let name = session_title.clone().unwrap_or_else(|| "An agent".into());
        let title = match kind {
            NoticeKind::Question => format!("{name} needs your answer"),
            NoticeKind::Approval => format!("{name} needs approval"),
            NoticeKind::Finished => format!("{name} finished"),
            NoticeKind::Failed => format!("{name} stopped on an error"),
            NoticeKind::UsageLimit => format!("{name} reached a usage limit"),
            NoticeKind::PrChecksFailed | NoticeKind::PrMerged | NoticeKind::BotQuestion => unreachable!("agent events make no pull request or bot notice"),
        };
        let mut notification = self.notification(kind, title, body, &event.session_id, &event.tab_id, session_title);
        notification.question = question;
        notification.approval = approval;
        Some(notification)
    }

    /// The notice for a pipeline's news, once per news (`PhoneNotice::key`),
    /// and only for news since this app started.
    fn pipeline_notification(&self, notice: crate::issue_pipeline::engine::PhoneNotice, author_title: Option<String>) -> Option<MobileNotification> {
        use crate::issue_pipeline::engine::PhoneNoticeKind;
        if notice.at < self.started { return None; }
        {
            let mut sent = self.pipeline_notices.lock().unwrap();
            if sent.contains(&notice.key) { return None; }
            sent.push_back(notice.key);
            while sent.len() > NOTIFICATION_LIMIT { sent.pop_front(); }
        }
        let (kind, title) = match notice.kind {
            PhoneNoticeKind::ChecksFailed => (NoticeKind::PrChecksFailed, format!("Checks failed on {}", notice.pull_request)),
            PhoneNoticeKind::Merged => (NoticeKind::PrMerged, format!("{} merged", notice.pull_request)),
        };
        let session_title = author_title.filter(|title| !title.trim().is_empty());
        Some(self.notification(kind, title, collapse_notification_text(&notice.detail), &notice.author.session_id, &notice.author.tab_id, session_title))
    }

    /// Tell every phone to read its capabilities again when Bots was switched
    /// on or off since last looked at (PRO-479).
    fn watch_bots_switch(&self, on: bool) {
        if self.bots_on.swap(on, std::sync::atomic::Ordering::SeqCst) != on {
            self.broadcast_capabilities_changed();
        }
    }

    /// The notices bot `bot_id`'s list makes now: one for each question it
    /// asks its owner that was asked since this app started and has not been
    /// noticed (PRO-479). None while Bots is off.
    fn bot_notifications(&self, bot_id: &str) -> Vec<MobileNotification> {
        if !crate::bots::enabled() { return Vec::new(); }
        let (Ok(bot), Ok(list)) = (crate::bots::get(bot_id), crate::bots::items::read(bot_id)) else { return Vec::new() };
        let chat = crate::bots::phone::home_chat_of(&bot.id);
        let mut notices = Vec::new();
        for item in list.items.iter().filter(|item| item.state == crate::bots::items::ItemState::NeedsYou) {
            let Some(question) = &item.question else { continue };
            let asked = chrono::DateTime::parse_from_rfc3339(&question.asked).ok().map(|at| at.with_timezone(&Utc));
            // Times are kept to the millisecond: one asked as this app started is news.
            if asked.is_none_or(|at| at + chrono::TimeDelta::seconds(1) < self.started) { continue; }
            let named = if question.id.is_empty() { question.asked.clone() } else { question.id.clone() };
            let key = format!("{}/{}/{named}", bot.id, item.number);
            {
                let mut sent = self.bot_notices.lock().unwrap();
                if sent.contains(&key) { continue; }
                sent.push_back(key);
                while sent.len() > NOTIFICATION_LIMIT { sent.pop_front(); }
            }
            notices.push(MobileNotification {
                seq: self.next_seq(),
                epoch: self.notification_epoch.clone(),
                title: format!("{} asks", bot.name),
                body: collapse_notification_text(&question.text),
                session_id: chat.as_ref().map(|(session, _)| session.clone()),
                tab_id: chat.as_ref().map(|(_, tab)| tab.clone()),
                kind: NoticeKind::BotQuestion,
                session_title: None,
                question: None,
                approval: None,
                bot_question: Some(BotQuestionNotice {
                    bot_id: bot.id.clone(),
                    number: item.number,
                    question: named,
                    answers: question.answers.clone(),
                    recommended: question.recommended.filter(|index| *index < question.answers.len()),
                }),
            });
        }
        notices
    }

    /// Whether this is the first notice of this tab's ask by its request id.
    fn first_ask(&self, tab_key: &str, request_id: &str) -> bool {
        let mut asked = self.asked.lock().unwrap();
        if asked.iter().any(|(tab, seen)| tab == tab_key && seen == request_id) { return false; }
        asked.push_back((tab_key.to_string(), request_id.to_string()));
        while asked.len() > NOTIFICATION_LIMIT { asked.pop_front(); }
        true
    }

    /// Kept for `notifications.missedSince`, streamed to subscriptions and
    /// sent to each connection that asked for it.
    fn publish(&self, sink: Option<&dyn EventSink>, notification: MobileNotification) {
        {
            let mut events = self.notifications.lock().unwrap();
            events.push_back(notification.clone());
            while events.len() > NOTIFICATION_LIMIT {
                events.pop_front();
            }
        }
        if let Some(sink) = sink {
            sink.emit("mobile_notification", &notification);
        }
        self.broadcast_notification(&notification);
    }

    fn missed_notifications(&self, epoch: Option<&str>, last_seen_seq: u64, filter: Option<&NotificationFilter>) -> Vec<MobileNotification> {
        self.notifications
            .lock()
            .unwrap()
            .iter()
            .filter(|event| epoch != Some(self.notification_epoch.as_str()) || event.seq > last_seen_seq)
            .filter(|event| admitted(filter, event))
            .cloned()
            .collect()
    }

}

pub(crate) struct MobileConnection {
    id: String,
    device: DeviceEntry,
    owner: Arc<dyn super::Owner>,
    actor: crate::local_runtime::mobile::Actor,
    runtime: Arc<MobileRuntime>,
    outbound: mpsc::Sender<Value>,
    wire: Wire,
    subscriptions: Mutex<HashMap<String, ListenerId>>,
    /// What this connection's latest `notifications.subscribe` asked for.
    notification_filter: ConnectionFilter,
    terminal_subscriptions: Mutex<HashMap<String,String>>,
    /// The request being answered and what its stream produced meanwhile:
    /// held until its reply is on the socket, so a subscription's opening
    /// result always comes before its first item (#1333).
    opening: Mutex<Option<(String, Vec<Value>)>>,
    polling: std::sync::atomic::AtomicBool,
    overflowed: Arc<std::sync::atomic::AtomicBool>,
    invalidations: Arc<super::Invalidations>,
    closed: std::sync::atomic::AtomicBool,
    /// The transcript checkpoints this connection's `session.sync` replies ended at (#1283).
    sync_cache: SyncCache,
    /// Sends what this connection's latest `sync.prefetch` asked for, on one
    /// thread: a newer request or a stop ends the one under way (#1338).
    prefetch: LatestWorker<PrefetchJob>,
    #[cfg(unix)]
    authority: Option<Box<dyn Fn() -> Result<()> + Send + Sync>>,
}

impl MobileConnection {
    /// `new`, with the runtime's `register` round trip off the async workers.
    pub(crate) async fn open(manager: &Arc<PhoneHost>, device: &DeviceEntry, outbound: mpsc::Sender<Value>, transport: Transport, forwarded_id: Option<String>) -> Result<Self> {
        let (manager, device) = (manager.clone(), device.clone());
        off_runtime_within(move || Self::new(&manager, &device, manager.mobile.clone(), outbound, transport, forwarded_id)).await
    }

    fn new(manager: &PhoneHost, device: &DeviceEntry, runtime: Arc<MobileRuntime>, outbound: mpsc::Sender<Value>, transport: Transport, forwarded_id: Option<String>) -> Result<Self> {
        let id = Uuid::new_v4().to_string();
        let owner = manager.owner().context("The local runtime is unavailable.")?;
        let attachment = owner.attachment()?;
        let actor = crate::local_runtime::mobile::Actor {
            epoch: attachment.epoch, lease: attachment.lease,
            generation: manager.generation(),
            user_id: account_mirror()?.map(|mirror| mirror.user_id),
        };
        owner.mobile(&actor, "register", json!({"connection":id,"deviceId":device.id,"forwardedId":forwarded_id}))?;
        let overflowed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let notification_filter = ConnectionFilter::default();
        let invalidations = Arc::new(super::Invalidations::default());
        runtime.register_client(&id, outbound.clone(), overflowed.clone(), notification_filter.clone(), invalidations.clone());
        Ok(Self {
            id, device: device.clone(), owner, actor, overflowed, notification_filter, invalidations,
            runtime,
            outbound,
            wire: Wire::new(transport),
            subscriptions: Mutex::new(HashMap::new()),
            terminal_subscriptions: Mutex::new(HashMap::new()),
            opening: Mutex::new(None),
            polling: std::sync::atomic::AtomicBool::new(false),
            closed: std::sync::atomic::AtomicBool::new(false),
            sync_cache: SyncCache::default(),
            prefetch: LatestWorker::new("mobile-prefetch", run_prefetch),
            #[cfg(unix)]
            authority: None,
        })
    }

    pub(crate) fn wire(&self) -> &Wire {
        &self.wire
    }

    pub(crate) fn invalidations(&self) -> &super::Invalidations {
        &self.invalidations
    }

    pub(crate) fn check_buffer(&self) -> Result<()> {
        if self.overflowed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(super::Fault::FellBehind.into());
        }
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(super::Fault::Closed.into());
        }
        #[cfg(unix)]
        if let Some(authority) = &self.authority {
            authority()?;
        }
        Ok(())
    }

    #[cfg(unix)]
    pub(crate) fn require_authority(&mut self, check: impl Fn() -> Result<()> + Send + Sync + 'static) {
        self.authority = Some(Box::new(check));
    }

    pub(crate) fn check(&self, manager: &PhoneHost) -> Result<()> {
        self.check_current(manager)?;
        self.call("check", json!({}))?;
        Ok(())
    }

    /// `check`, with the runtime round trip off the async workers.
    pub(crate) async fn check_off_runtime(self: &Arc<Self>, manager: &PhoneHost) -> Result<()> {
        self.check_current(manager)?;
        let connection = self.clone();
        off_runtime_within(move || connection.call("check", json!({})).map(drop)).await
    }

    pub(crate) async fn output_permit(self: &Arc<Self>, manager: &PhoneHost) -> Result<std::fs::File> {
        self.check_current(manager)?;
        let connection = self.clone();
        off_runtime_within(move || {
            connection.call("check", json!({}))?;
            super::registry::DeviceRegistry.output_permit(&connection.device)
        }).await
    }

    /// Whether this phone's credential is gone from the device registry:
    /// revoked or replaced. `false` when the registry cannot be read.
    pub(crate) async fn credential_revoked(&self) -> bool {
        let device = self.device.clone();
        off_runtime_within(move || super::registry::DeviceRegistry.list())
            .await
            .is_ok_and(|devices| !devices.iter().any(|entry| entry.id == device.id && entry.token == device.token))
    }

    fn check_current(&self, manager: &PhoneHost) -> Result<()> {
        self.check_buffer()?;
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) || self.actor.generation != manager.generation() {
            return Err(super::Fault::Changed.into());
        }
        Ok(())
    }

    fn call(&self, method: &str, mut params: Value) -> Result<Value> {
        params.as_object_mut().context("Mobile parameters must be an object.")?.insert("connection".into(), json!(self.id));
        self.owner.mobile(&self.actor, method, params).map_err(outdated)
    }

    pub(crate) fn close(&self) { self.finish(); }

    fn finish(&self) {
        if self
            .closed
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        self.prefetch.stop();
        if let Some(sink) = self.runtime.sink.get() {
            for (_, listener) in self.subscriptions.lock().unwrap().drain() {
                sink.unlisten(listener);
            }
        }
        self.runtime.unregister_client(&self.id);
        let (owner, actor, id) = (self.owner.clone(), self.actor.clone(), self.id.clone());
        let close = move || {
            if owner.mobile(&actor, "close", json!({"connection": id})).is_err() { owner.disconnect(); }
        };
        // Closing runs on async workers and in Drop: keep the round trip off them (#666).
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => { runtime.spawn_blocking(close); }
            Err(_) => close(),
        }
    }

    fn stream(&self, request_id: &str, result: Value) {
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) { return; }
        let mut opening = self.opening.lock().unwrap();
        if let Some((id, held)) = opening.as_mut().filter(|(id, _)| id == request_id) {
            // As many as the queue holds: a stream that outruns it falls behind as a queued one would.
            if held.len() >= self.outbound.max_capacity() {
                log::debug!("stream {id} filled before its reply was sent");
                self.overflowed.store(true, std::sync::atomic::Ordering::SeqCst);
                drop(opening);
                self.finish();
                return;
            }
            held.push(success_response(request_id, result));
            return;
        }
        // Queued under the lock, so a stream released meanwhile keeps its order.
        self.queue(success_response(request_id, result));
    }

    fn queue(&self, message: Value) {
        if let Err(error) = self.outbound.try_send(message) {
            if matches!(error, mpsc::error::TrySendError::Full(_)) {
                self.overflowed.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            self.finish();
        }
    }

    /// Hold what `request_id`'s stream produces until `opened`: called before
    /// the request is answered.
    pub(crate) fn opening(&self, request_id: &str) {
        *self.opening.lock().unwrap() = Some((request_id.to_string(), Vec::new()));
    }

    /// `request_id`'s reply was sent: what its stream held is queued, in
    /// order, ahead of anything it streams later.
    pub(crate) fn opened(&self, request_id: &str) {
        let mut opening = self.opening.lock().unwrap();
        if opening.as_ref().is_none_or(|(id, _)| id != request_id) { return; }
        let (_, held) = opening.take().expect("checked");
        for message in held {
            if self.closed.load(std::sync::atomic::Ordering::SeqCst) { return; }
            self.queue(message);
        }
    }

    /// A live event, cut down when this connection cannot carry it whole: a
    /// reply it cannot carry would end the subscription (#669).
    fn stream_event(&self, request_id: &str, event: &AgentEvent) -> Result<()> {
        let envelope = serde_json::to_vec(&success_response(request_id, json!({ "event": null })))?.len();
        let event = fit_event(event, self.wire.message_limit().saturating_sub(envelope))?;
        self.stream(request_id, json!({ "event": event }));
        Ok(())
    }

    fn insert_subscription(&self, subscription_id: String, event_id: ListenerId) {
        self.subscriptions.lock().unwrap().insert(subscription_id, event_id);
    }

    fn unsubscribe(&self, subscription_id: &str) -> Result<bool> {
        if self.terminal_subscriptions.lock().unwrap().contains_key(subscription_id) {
            let result = self.call("unobserve", json!({"subscriptionId":subscription_id}))?;
            self.terminal_subscriptions.lock().unwrap().remove(subscription_id);
            return Ok(result["removed"].as_bool().unwrap_or(false));
        }
        let listener = self.subscriptions.lock().unwrap().remove(subscription_id);
        forget_filter(&self.notification_filter, subscription_id);
        if let (Some(sink), Some(listener)) = (self.runtime.sink.get(), listener) {
            sink.unlisten(listener);
            Ok(true)
        } else { Ok(false) }
    }

    fn start_polling(self: &Arc<Self>) -> Result<()> {
        if self.polling.swap(true,std::sync::atomic::Ordering::SeqCst) { return Ok(()); }
        let weak = Arc::downgrade(self);
        let spawned = std::thread::Builder::new().name("mobile-output".into()).spawn(move || loop {
            let Some(connection) = weak.upgrade() else { return };
            if connection.closed.load(std::sync::atomic::Ordering::SeqCst) { return; }
            if !connection.terminal_subscriptions.lock().unwrap().is_empty() {
                match connection.call("output",json!({})) {
                    Ok(packets) => {
                        for packet in packets.as_array().into_iter().flatten() {
                            let request = connection.terminal_subscriptions.lock().unwrap()
                                .get(packet["subscriptionId"].as_str().unwrap_or_default()).cloned();
                            if let Some(request) = request {
                                if packet.get("cols").is_some() {
                                    connection.stream(&request,json!({"type":"resized","cols":packet["cols"],"rows":packet["rows"]}));
                                }
                                if packet["text"].as_str().is_some_and(|text| !text.is_empty()) {
                                    connection.stream(&request,json!({"type":"data","chunk":packet["text"]}));
                                }
                            }
                        }
                    }
                    Err(error) => {
                        let _ = connection.outbound.try_send(json!({"method":"terminal.closed","params":{"message":error.to_string()}}));
                        connection.finish();
                        return;
                    }
                }
            }
            drop(connection);
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        if let Err(error) = spawned {
            self.polling.store(false,std::sync::atomic::Ordering::SeqCst);
            self.finish();
            return Err(error.into());
        }
        Ok(())
    }

}

impl Drop for MobileConnection {
    fn drop(&mut self) { self.finish(); }
}

/// Synchronous throughout: callers run it with `off_runtime`.
pub(crate) fn dispatch(
    manager: &PhoneHost,
    connection: &Arc<MobileConnection>,
    request: &Value,
    device: &DeviceEntry,
) -> Option<Result<Value>> {
    if let Err(error) = crate::data_privacy::require_network() { return Some(Err(error)); }
    if let Err(error) = connection.check(manager) { return Some(Err(error)); }
    let method = request.get("method")?.as_str()?;
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let sink = manager.sink().cloned();
    let result = match method {
        "sync.capabilities" => no_params(&params).map(|_| capabilities_for(connection.owner.build(), crate::bots::enabled())),
        "transport.negotiate" => parse_params(params).map(|params| negotiate(connection, params)),
        "sessions.summaries" => parse_params(params).and_then(|params: ConditionalParams| conditional(session_summaries(connection)?, params.version)),
        "session.sync" => parse_params(params).and_then(|params| session_sync(connection, request_id(request), params)),
        "session.tail" => parse_params(params).and_then(|params| session_tail(connection, request_id(request), params)),
        "sync.prefetch" => parse_params(params).and_then(|params| prefetch(connection, params)),
        "sync.prefetchTargets" => no_params(&params).and_then(|_| prefetch_targets_reply()),
        "session.image" => parse_params(params).and_then(|params: PromptImageParams| prompt_image(&params)),
        "session.subscribe" => sink
            .as_ref()
            .context("app is unavailable")
            .and_then(|sink| parse_params(params).and_then(|params| subscribe_session(&**sink, connection, request_id(request), params))),
        "session.unsubscribe" | "terminal.unsubscribe" | "notifications.unsubscribe" => {
            parse_params(params).and_then(|params: UnsubscribeParams| Ok(json!({ "removed": connection.unsubscribe(&params.subscription_id)? })))
        }
        "session.send" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| send_session(manager, connection, params)))
        }
        "permission.respond" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| respond_permission(connection, params)))
        }
        "questions.respond" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| respond_questions(connection, params)))
        }
        // Session controls (`sessionControls`): the desktop's own operations,
        // which the runtime checks against this device's grant again.
        "session.markRead" => parse_params(params).and_then(|params: TabControlParams| connection.call("markRead", params.into_call())),
        "session.tab" => parse_params(params).and_then(|params: TabControlParams| connection.call("tab", params.into_call())),
        "models.list" => parse_params(params).and_then(|params: ModelsParams| connection.call("models", json!({"refresh": params.refresh}))),
        "session.prepareContinuation" => parse_params(params).and_then(|params: TabControlParams| connection.call("prepareContinuation", params.into_call())),
        "session.stop" | "session.interrupt" | "session.resendUnsent" | "session.closeTab" => require_driver(device).and_then(|_| parse_params(params).and_then(|params: TabControlParams| {
            connection.call(method.trim_start_matches("session."), params.into_call())
        })),
        "session.setModel" | "session.setEffort" | "session.setMode" => require_driver(device).and_then(|_| parse_params(params).and_then(|params: TabSettingParams| {
            connection.call(method.trim_start_matches("session."), params.into_call(method))
        })),
        "session.continue" => require_driver(device).and_then(|_| parse_params(params).and_then(|params: ContinueParams| {
            connection.call("continue", json!({"sessionId": params.session_id, "tabId": params.tab_id, "tab": params.tab, "prompt": params.prompt}))
        })),
        // Pins (`pin`, #1403): a session's, and a cloud project's, as the Mac's
        // sidebar sets them; the runtime checks this device may drive again.
        "sessions.pin" => require_driver(device).and_then(|_| parse_params(params).and_then(|params: PinParams| {
            connection.call("pin", json!({"sessionId": params.session_id, "pinned": params.pinned}))
        })),
        "cloud.pins" => no_params(&params).and_then(|_| cloud_pins_reply()),
        "cloud.pin" => require_driver(device).and_then(|_| parse_params(params).and_then(|params: CloudPinParams| {
            connection.call("cloudPin", json!({"orgId": params.org_id, "identity": params.identity, "pinned": params.pinned}))
        })),
        "chat.list" => parse_params(params).and_then(|params| list_notes(manager, params)),
        "chat.post" => parse_params(params).and_then(|params| post_note(manager, device, params)),
        "chat.promoteToAgent" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| promote_notes(manager, connection, params)))
        }
        "terminal.read" => parse_params(params).and_then(|params| read_terminal(connection, params)),
        "terminal.open" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| open_terminal(connection, params)))
        }
        "terminal.subscribe" => parse_params(params).and_then(|params| subscribe_terminal(connection, request_id(request), params)),
        "steerLease.queueInput" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| queue_input(connection, params)))
        }
        "steerLease.release" => parse_params(params).and_then(|params| release_input(connection, params)),
        "sessions.options" => no_params(&params).and_then(|_| new_session_options(manager, connection.owner.build(), require_driver(device).is_ok())),
        "sessions.create" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params| create_session(manager, connection, params)))
        }
        "configuration.resolve" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params { #[serde(default)] project_id: Option<String> }
            parse_params(params).and_then(|p: Params| connection.call("configuration", json!({"projectId": p.project_id})))
        }
        "mac.settings" => no_params(&params).and_then(|_| connection.call("settings", json!({}))),
        "mac.setSettings" => {
            require_driver(device).and_then(|_| parse_params(params).and_then(|params: MacSettingsPatch| connection.call("setSettings", json!({"nativeCodex": params.native_codex}))))
        }
        // The bots (PRO-479), while Bots is on: reads, and the owner's acts, which
        // the runtime makes through the window's own operations.
        "bots.list" => no_params(&params).and_then(|_| connection.call("bots", json!({"operation": "list"}))),
        "bots.home" | "bots.items" => parse_params(params).and_then(|params: BotParams| {
            connection.call("bots", json!({"operation": method.trim_start_matches("bots."), "id": params.id}))
        }),
        "bots.answer" => require_driver(device).and_then(|_| parse_params(params).and_then(|params: BotAnswerParams| connection.call("bots", params.into_call()))),
        "bots.pause" | "bots.resume" => require_driver(device).and_then(|_| parse_params(params).and_then(|params: BotParams| {
            connection.call("bots", json!({"operation": method.trim_start_matches("bots."), "id": params.id}))
        })),
        "bots.pauseAll" => require_driver(device).and_then(|_| no_params(&params).and_then(|_| connection.call("bots", json!({"operation": "pauseAll"})))),
        "notifications.missedSince" => parse_params(params).map(|params| missed_notifications(manager, params)),
        "notifications.subscribe" => sink
            .as_ref()
            .context("app is unavailable")
            .and_then(|sink| parse_params(params).and_then(|params| subscribe_notifications(&**sink, connection, request_id(request), params))),
        _ => return None,
    };
    Some(result)
}

/// What this Mac understands beyond the first phone protocol, through
/// `runtime`, the runtime the phone's connection was admitted by. A phone
/// sends a field only to a Mac that names it here: every params type refuses
/// fields it does not know. And it offers a feature only when it is named:
/// one that the app knows and its runtime does not would be offered and then
/// refused (#730), so those are named only as far as the runtime serves them
/// (`local_runtime::mobile::features`).
///
/// `bots` is named only while Settings → Experimental → Bots is on
/// (`bots_on`): with it off, a phone shows nothing of the bots (PRO-479).
/// Turning it on or off tells every phone to ask again (`watch_bots_switch`).
fn capabilities_for(runtime: &crate::local_runtime::client::Build, bots_on: bool) -> Value {
    // `transcript`, `conditionalLists` and `promptImages` (`session.image`) are this app's own.
    // `notificationFilters`: notices carry a `kind`, and `notifications.subscribe`
    // and `notifications.missedSince` take a `filter` (#990).
    // `prefetch`: `sync.prefetch` sends the newest part of the most recently
    // active conversations ahead of time, as `session.prefetch` (#1283).
    // `prefetchOpen`: it takes `open`, the conversations on the phone's screen, and sends none of them (#1337).
    // `prefetchTargets`: `sync.prefetchTargets` names the conversations a
    // prefetch would send, so the phone names its checkpoints for those (#1339).
    let mut named = json!({ "transcript": 1, "conditionalLists": 1, "promptImages": 1, "notificationFilters": 1, "prefetch": 1, "prefetchOpen": 1, "prefetchTargets": 1 });
    // `sendIds`: `session.send` and `chat.post` take a `clientMessageId` (#675).
    // `sessionControls`: stop, interrupt, recovery, settings and continuing in
    // a new tab, as the desktop offers them.
    // `sessionCreate`: `sessions.options` and `sessions.create` start a session
    // as the desktop does. `macSettings`: `mac.settings` and `mac.setSettings`.
    // `terminal`: `terminal.open`, and terminal observations that carry the
    // pane's size, so the phone can emulate the screen and drive it.
    // `closeTab`: `session.closeTab` closes a tab as the desktop's tab strip does.
    // `questions`: `questions.respond` answers an agent's question as the desktop's card does (#979).
    // `bots`: `bots.list`, `bots.home`, `bots.items`, `bots.answer`, `bots.pause`,
    // `bots.resume` and `bots.pauseAll`, and `bot_question` notices (PRO-479).
    // `pin`: `sessions.pin`, `cloud.pins` and `cloud.pin` read and set what the
    // sidebar pins, sessions and cloud projects (#1403).
    for (feature, level) in [("sendIds", 1), ("sessionControls", 1), ("sessionCreate", 1), ("macSettings", 1), ("terminal", 1), ("closeTab", 1), ("layeredConfiguration", 1), ("questions", 1), ("bots", 1), ("pin", 1)] {
        if feature == "bots" && !bots_on { continue; }
        if runtime.mobile.get(feature).and_then(Value::as_u64).is_some_and(|served| served >= level) {
            named[feature] = json!(level);
        }
    }
    named
}

/// One bot, for a read or a pause.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BotParams {
    id: String,
}

/// The owner's answer to a bot's question, from the phone (PRO-479): one of
/// its answers by index, or their own words, to the question they saw.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BotAnswerParams {
    id: String,
    number: u64,
    #[serde(default)]
    answer: Option<u64>,
    #[serde(default)]
    text: Option<String>,
    /// The question's id as the phone was shown it (its `asked` time, for one an older build asked).
    #[serde(default)]
    question: Option<String>,
}

impl BotAnswerParams {
    fn into_call(self) -> Value {
        let mut call = json!({"operation": "answer", "id": self.id, "number": self.number});
        match (self.answer, self.text) {
            (Some(index), _) => call["answer"] = json!(index),
            (None, Some(text)) => call["text"] = json!(text),
            (None, None) => {}
        }
        if let Some(question) = self.question { call["question"] = json!(question); }
        call
    }
}

/// What a phone is told when the runtime refuses an operation it does not
/// know: a feature this Mac named and its runtime cannot serve after all.
pub(crate) const OUTDATED: &str = "TerminalX on your Mac needs updating or restarting to do this.";

/// The runtime's refusal of an operation it does not know, said so a person
/// knows what to do (#730). Any other error is left as it is.
fn outdated(error: anyhow::Error) -> anyhow::Error {
    let unknown = error.chain().any(|cause| cause.downcast_ref::<crate::local_runtime::client::Refused>()
        .is_some_and(|refused| refused.message == crate::local_runtime::mobile::UNSUPPORTED));
    if unknown { anyhow!("{}", crate::platform_profile::localize(OUTDATED)) } else { error }
}

/// One tab, for a control that takes nothing else.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptImageParams {
    session_id: String,
    tab_id: String,
    /// The image's place on the Mac, as the transcript names it.
    path: String,
}

/// The largest prompt image a phone is sent: under the fragmented message limit once encoded.
const MAX_PROMPT_IMAGE_BYTES: usize = 7 * 1024 * 1024;

/// An image a prompt in this session carried, for the phone to draw where the
/// desktop draws it. Only the session's own attachments are read: any other
/// path, a link out of that folder among them, is refused.
fn prompt_image(params: &PromptImageParams) -> Result<Value> {
    validate_session_tab(&params.session_id, &params.tab_id)?;
    let folder = store::attachments_dir(&params.session_id)?.canonical()?;
    let path = Path::new(&params.path).canonical().map_err(|_| anyhow!("{}", crate::platform_profile::localize("The image is no longer on the Mac.")))?;
    if !path.starts_with(&folder) {
        bail!("That image is not one of this session's attachments.");
    }
    let media_type = match path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        _ => bail!("That attachment is not an image."),
    };
    let size = std::fs::metadata(&path)?.len() as usize;
    if size > MAX_PROMPT_IMAGE_BYTES {
        bail!("{}", crate::platform_profile::localize(&format!("The image is {}, too large to show on the phone. Open it on your Mac.", megabytes(size))));
    }
    Ok(json!({ "mediaType": media_type, "data": general_purpose::STANDARD.encode(std::fs::read(&path)?) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TabControlParams {
    session_id: String,
    tab_id: String,
}
impl TabControlParams {
    fn into_call(self) -> Value { json!({"sessionId": self.session_id, "tabId": self.tab_id}) }
}

/// Pin or unpin a session on the Mac (`sessions.pin`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PinParams {
    session_id: String,
    pinned: bool,
}

/// Pin or unpin a cloud project on the Mac (`cloud.pin`): by its
/// organization and its repository identity, as the sidebar names it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudPinParams {
    org_id: String,
    identity: String,
    pinned: bool,
}

/// The cloud projects pinned on this Mac, per organization (`cloud.pins`).
fn cloud_pins_reply() -> Result<Value> {
    Ok(json!({ "orgs": store::cloud_pins::load()?.orgs }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelsParams {
    #[serde(default)]
    refresh: bool,
}

/// A model, an effort (none for the agent's own default) or a permission mode.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TabSettingParams {
    session_id: String,
    tab_id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    mode: Option<String>,
}
impl TabSettingParams {
    fn into_call(self, method: &str) -> Value {
        let mut call = json!({"sessionId": self.session_id, "tabId": self.tab_id});
        match method {
            "session.setModel" => call["model"] = json!(self.model.unwrap_or_default()),
            "session.setEffort" => call["effort"] = json!(self.effort),
            _ => call["mode"] = json!(self.mode.unwrap_or_default()),
        }
        call
    }
}

/// "Continue in new session": the source tab, the new tab's agent and
/// settings, and the prompt built from the prepared context.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContinueParams {
    session_id: String,
    tab_id: String,
    tab: ContinueTab,
    prompt: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContinueTab {
    harness: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    permission_mode: Option<String>,
}

fn request_id(request: &Value) -> &str {
    request.get("id").and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn success_response(id: &str, result: Value) -> Value {
    json!({ "id": id, "ok": true, "result": result, "_meta": { "runtimeId": "desktop" } })
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).context("invalid paired-device RPC params")
}

fn no_params(params: &Value) -> Result<()> {
    if params.as_object().is_some_and(serde_json::Map::is_empty) {
        Ok(())
    } else {
        bail!("this method accepts no params")
    }
}

fn require_driver(device: &DeviceEntry) -> Result<()> {
    if device.scope == DeviceScope::Driver {
        Ok(())
    } else {
        bail!("this paired device is read-only")
    }
}

/// What the Mac's project list calls a session's row: its branch, by the
/// label the reader gave it, or `None` when the branch is only a drawn
/// worktree name (`dc/calm-ember-panda`), which the list leaves for the
/// conversation's title.
fn row_branch(session: &SessionEntry, labels: Option<&std::collections::BTreeMap<String, String>>) -> Option<String> {
    let branch = session.branch.as_deref().filter(|branch| !branch.is_empty())?;
    if let Some(label) = labels.and_then(|labels| labels.get(branch)) {
        return Some(label.clone());
    }
    let name = branch.rsplit('/').next().unwrap_or(branch);
    (!crate::names::is_worktree_name(name)).then(|| branch.to_string())
}

/// The group a paired phone files quick chats under.
const QUICK_CHATS_PROJECT: &str = "Quick chats";

fn session_summaries(connection: &MobileConnection) -> Result<Value> {
    summaries_with_row_statuses(connection.call("rowStatuses", json!({})).unwrap_or(Value::Null))
}

/// `row_statuses` maps a session id to its row status; a runtime without them leaves them out.
fn summaries_with_row_statuses(row_statuses: Value) -> Result<Value> {
    let snippets: HashMap<_, _> = summaries::collect(None)?
        .into_iter()
        .map(|summary| (summary.session_id.clone(), summary))
        .collect();
    // The names the reader gave branches, by project, as the Mac's project list shows them.
    let labels: HashMap<String, std::collections::BTreeMap<String, String>> =
        store::projects::list()?.0.into_iter().map(|project| (project.path, project.branch_labels)).collect();
    let live: Vec<_> = store::conversation_titles::backfill()?.into_iter().filter(|session| !session.archived).collect();
    let ranks = pinned_ranks(&live, &index::sidebar_order()?);
    let mut sessions = Vec::new();
    for session in live {
        let summary = snippets.get(&session.id);
        // The name made for each tab, as the Mac names it (absent for a tab the
        // reader named or one nothing has been made for); older phones ignore it.
        let generated = summaries::generated_tab_titles(&session);
        // A quick chat has no project: its path is a scratch directory named
        // for the session, which would give the phone one group per chat.
        let quick = session.is_quick();
        let project = if quick { QUICK_CHATS_PROJECT.to_string() } else { file_name(&session.project_path) };
        let worktree = if quick && store::quick::is_scratch(&session.id, &session.cwd) {
            "scratch".to_string()
        } else {
            session
                .worktree_name
                .clone()
                .or_else(|| session.branch.clone())
                .unwrap_or_else(|| file_name(&session.cwd))
        };
        let branch = if quick { None } else { row_branch(&session, labels.get(&session.project_path)) };
        sessions.push(json!({
            "id": session.id,
            "kind": if quick { "quick" } else { "project" },
            "branch": branch,
            "title": session.title,
            "manualStatus": session.manual_status,
            "project": project,
            "worktree": worktree,
            "modified": summary.map(|row| row.updated_at.clone()).unwrap_or(session.modified),
            "lastPrompt": summary.and_then(|row| row.last_prompt.clone()),
            "lastReply": summary.and_then(|row| row.last_reply.clone()),
            "issueRef": session.issue.as_ref().map(|issue| issue.identifier.clone()),
            // Pinned on the Mac: the phone lists it in its Pinned section (#1403),
            // at `pinnedRank` while the sidebar is in its custom order. Older phones ignore both.
            "pinned": session.pinned,
            "pinnedRank": ranks.get(&session.id),
            "rowStatus": row_statuses[&session.id],
            "tabs": session.tabs.into_iter().map(|tab| json!({
                "id": tab.id,
                "title": tab.title,
                "generatedTitle": generated.get(&tab.id),
                "harness": tab.harness,
                "status": tab.status,
                "markedUnread": tab.marked_unread,
                // When the tab was last active: the phone's list shows it on each tab's row.
                "modified": tab.modified,
            })).collect::<Vec<_>>(),
        }));
    }
    sessions.sort_by(|left, right| {
        right
            .get("modified")
            .and_then(Value::as_str)
            .cmp(&left.get("modified").and_then(Value::as_str))
    });
    Ok(json!({ "sessions": sessions }))
}

/// Where each pinned session stands in the Mac's Pinned group while the
/// sidebar is in its custom (dragged) order, as the sidebar places them
/// (`customSessionOrder`): sessions the saved order does not hold yet first,
/// newest created first, then the saved order. Empty otherwise: the phone
/// lists them by their latest activity then (#1403).
fn pinned_ranks(sessions: &[index::SessionEntry], order: &index::SidebarOrder) -> HashMap<String, usize> {
    if !order.custom { return HashMap::new(); }
    let saved: HashMap<&str, usize> = order.sessions.iter().enumerate().map(|(at, id)| (id.as_str(), at)).collect();
    let mut pinned: Vec<_> = sessions.iter().filter(|session| session.pinned).collect();
    pinned.sort_by(|a, b| {
        let (left, right) = (saved.get(a.id.as_str()), saved.get(b.id.as_str()));
        // `None` (not saved yet) sorts before every saved place, as on the Mac.
        left.cmp(&right).then_with(|| b.created.cmp(&a.created)).then_with(|| a.id.cmp(&b.id))
    });
    pinned.into_iter().enumerate().map(|(rank, session)| (session.id.clone(), rank)).collect()
}

/// What the phone's end of the connection can do (#669). Unknown fields are
/// ignored: a phone newer than this desktop may offer more than it knows.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NegotiateParams {
    #[serde(default)]
    fragments: Option<u64>,
}

fn negotiate(connection: &MobileConnection, params: NegotiateParams) -> Value {
    if connection.wire.negotiate(params.fragments) {
        json!({ "fragments": super::wire::FRAGMENTS_VERSION })
    } else {
        json!({})
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Project")
        .into()
}

// A content checkpoint, not a maximum event sequence: rewrites, reconciliation,
// truncation and replacement logs must never silently keep stale cached events.
const SYNC_PAGE_EVENTS: usize = 500;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SyncCursor {
    pub offset: usize,
    pub digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSyncParams {
    session_id: String,
    tab_id: String,
    cursor: Option<SyncCursor>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConditionalParams {
    version: Option<String>,
}

fn conditional(mut value: Value, previous: Option<String>) -> Result<Value> {
    let version = format!("{:x}", Sha256::digest(serde_json::to_vec(&value)?));
    if previous.as_deref() == Some(&version) {
        return Ok(json!({ "notModified": true, "version": version }));
    }
    value["version"] = json!(version);
    Ok(value)
}

fn session_sync(connection: &MobileConnection, request_id: &str, params: SessionSyncParams) -> Result<Value> {
    // Read errors are not deletions. Only an authoritative index absence clears
    // the phone's copy.
    let present = index::load()?.iter().any(|session|
        session.id == params.session_id && session.tab(&params.tab_id).is_some());
    if !present {
        return Ok(json!({ "deleted": true }));
    }
    let path = store::log_path(&params.session_id, &params.tab_id)?;
    // The next page of a read this connection is part way through (#1283):
    // the first page reconciled, and a live event asks for another read anyway.
    let continuing = params.cursor.as_ref()
        .is_some_and(|cursor| connection.sync_cache.continuing(&params.session_id, &params.tab_id, cursor));
    if !continuing {
        connection.call("reconcile", json!({"sessionId":params.session_id,"tabId":params.tab_id}))?;
    }
    // Reconciliation publishes to the log. Read canonical file order again:
    // another publisher may have appended between the first read and publish.
    let limits = connection.wire.reply_limits(TAIL_RESPONSE_BYTES_LIMIT);
    synced_page((&connection.sync_cache, Reader::Phone), &path, params.cursor.as_ref(), &params.session_id, &params.tab_id, request_id, limits)
}

/// A `session.sync` page of the log at `path`. A cursor this connection
/// verified before is continued from the bytes appended since, without reading
/// or hashing the log again (#1283); any other, or a log that is not the one
/// verified plus appended lines, is checked against the whole log as before.
/// The page's end is kept as `reader`'s checkpoint, beside the other's.
fn synced_page(reader: (&SyncCache, Reader), path: &Path, cursor: Option<&SyncCursor>, session: &str, tab: &str, request_id: &str, limits: ReplyLimits) -> Result<Value> {
    synced_page_while(reader, path, cursor, session, tab, request_id, limits, Wanted::ALWAYS)
}

/// `synced_page`, given up with `Stopped` once it is no longer `wanted`: a
/// prefetch that a newer one replaced stops inside a whole-log read (#1338).
/// Nothing is kept of a page given up.
#[allow(clippy::too_many_arguments)]
fn synced_page_while((cache, reader): (&SyncCache, Reader), path: &Path, cursor: Option<&SyncCursor>, session: &str, tab: &str, request_id: &str, limits: ReplyLimits, wanted: Wanted) -> Result<Value> {
    if let Some(cursor) = cursor {
        if let Some(verified) = cache.matching(session, tab, cursor) {
            if let Some(tail) = super::sync_cache::read_after(path, &verified, wanted)? {
                let page = forward_page(verified.hash.clone(), verified.offset, &tail.events, request_id, limits)?;
                cache.store(session, tab, reader, verified.advance(&page, &tail));
                return Ok(page.value);
            }
        }
    }
    let log = super::sync_cache::read_log(path, wanted)?;
    let page = sync_page_state(&log.events, cursor, session, tab, request_id, limits, wanted)?;
    cache.store(session, tab, reader, Verified::of_log(&page, &log));
    Ok(page.value)
}

#[cfg(test)]
fn sync_page(events: &[AgentEvent], cursor: Option<&SyncCursor>, session: &str, tab: &str, request_id: &str, limits: ReplyLimits) -> Result<Value> {
    Ok(sync_page_state(events, cursor, session, tab, request_id, limits, Wanted::ALWAYS)?.value)
}

/// A sync page, and the checkpoint it ends at: its cursor's offset and the
/// hash of every record before it, to continue from.
pub(super) struct SyncedPage {
    pub value: Value,
    pub end: usize,
    pub hash: Sha256,
    pub has_more: bool,
}

/// A new hash over a conversation's records, bound to its identity and protocol generation.
pub(super) fn sync_hash(session: &str, tab: &str) -> Result<Sha256> {
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&(1, session, tab))?);
    Ok(hash)
}

fn hash_events<'a>(hash: &mut Sha256, events: impl IntoIterator<Item = &'a AgentEvent>, wanted: Wanted) -> Result<()> {
    for (index, event) in events.into_iter().enumerate() {
        if index % WANTED_EVERY == 0 { wanted.check()?; }
        hash.update(serde_json::to_vec(event)?);
        hash.update(b"\n");
    }
    Ok(())
}

/// The sync reply's metadata at its largest, for a log of `total` records,
/// so a page leaves room for it. False is longer than true.
fn sync_envelope(request_id: &str, total: usize, limits: ReplyLimits) -> Result<(usize, usize)> {
    let envelope = success_response(request_id, json!({
        "events": [], "reset": false, "hasMore": false, "hasEarlier": false,
        "cursor": SyncCursor { offset: total, digest: "0".repeat(64) },
    }));
    let envelope = serde_json::to_vec(&envelope)?.len();
    let budget = limits.page.checked_sub(envelope).context("transcript request envelope is too large")?;
    let single = limits.single.checked_sub(envelope).context("transcript request envelope is too large")?;
    Ok((budget, single))
}

fn sync_page_state(events: &[AgentEvent], cursor: Option<&SyncCursor>, session: &str, tab: &str, request_id: &str, limits: ReplyLimits, wanted: Wanted) -> Result<SyncedPage> {
    // Hash canonical records with explicit boundaries, including conversation
    // identity and protocol generation. Stable across desktop restarts.
    let mut hash = sync_hash(session, tab)?;
    let offset = cursor.map_or(0, |c| c.offset);
    hash_events(&mut hash, events.iter().take(offset), wanted)?;
    let valid = cursor.is_some_and(|c| c.offset <= events.len()
        && c.digest == format!("{:x}", hash.clone().finalize()));
    if valid {
        return forward_page(hash, offset, &events[offset..], request_id, limits);
    }
    let mut start = events.len();
    let mut turns = 0;
    for event in events.iter().rev().take(SYNC_PAGE_EVENTS) {
        start -= 1;
        if matches!(event.payload, Payload::UserMessage { .. }) { turns += 1; }
        if turns == 20 { break; }
    }
    let (budget, single) = sync_envelope(request_id, events.len(), limits)?;
    // A reset is a recent contiguous suffix. It cannot skip an oversized
    // event: it is sent alone, and cut down to fit if it must be.
    start = events.len() - sync_event_count(events[start..].iter().rev(), budget)?;
    let mut hash = sync_hash(session, tab)?;
    hash_events(&mut hash, events, wanted)?;
    let page = events[start..].iter().map(|event| fit_event(event, single)).collect::<Result<Vec<_>>>()?;
    Ok(SyncedPage {
        value: json!({
            "events": page, "reset": true,
            "cursor": SyncCursor { offset: events.len(), digest: format!("{:x}", hash.clone().finalize()) },
            "hasMore": false, "hasEarlier": start > 0,
        }),
        end: events.len(), hash, has_more: false,
    })
}

/// The forward page after a verified checkpoint: `hash` covers the `start`
/// records before it, and `rest` is every record after them. A page is a
/// prefix of `rest`; it cannot skip an oversized event either.
pub(super) fn forward_page(mut hash: Sha256, start: usize, rest: &[AgentEvent], request_id: &str, limits: ReplyLimits) -> Result<SyncedPage> {
    let total = start + rest.len();
    let (budget, single) = sync_envelope(request_id, total, limits)?;
    let count = sync_event_count(rest.iter().take(SYNC_PAGE_EVENTS), budget)?;
    // At most a page of records: not worth a check.
    hash_events(&mut hash, &rest[..count], Wanted::ALWAYS)?;
    let page = rest[..count].iter().map(|event| fit_event(event, single)).collect::<Result<Vec<_>>>()?;
    let end = start + count;
    Ok(SyncedPage {
        value: json!({
            "events": page, "reset": false,
            "cursor": SyncCursor { offset: end, digest: format!("{:x}", hash.clone().finalize()) },
            "hasMore": end < total, "hasEarlier": start > 0,
        }),
        end, hash, has_more: end < total,
    })
}

/// What one `sync.prefetch` sends at most (#1283): the most recently active
/// sessions, the most recently active tabs of each, and bytes in all. Each
/// message is held well under a Relay frame, so a live event waits behind
/// at most one of them.
const PREFETCH_SESSIONS: usize = 8;
const PREFETCH_TABS_PER_SESSION: usize = 3;
const PREFETCH_BYTES: usize = 2 * 1024 * 1024;
const PREFETCH_MESSAGE_BYTES: usize = 256 * 1024;
/// The checkpoints a phone may name: it names those of the conversations it keeps.
const PREFETCH_KNOWN: usize = 256;
/// A conversation the phone read this recently counts as open on its screen,
/// which polls every 15 s, and reads at once when it opens.
const PREFETCH_READING: std::time::Duration = std::time::Duration::from_secs(45);
/// A prefetch message waits until the connection's queue is at least half free, and gives up after this.
const PREFETCH_ROOM_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrefetchParams {
    /// False stops a prefetch under way: the phone went to the background, or the setting was turned off.
    enabled: bool,
    /// The checkpoints of the conversations the phone keeps: those are sent from there.
    #[serde(default)]
    known: Vec<KnownTranscript>,
    /// The conversations open on the phone's screen (#1337): they read for
    /// themselves, and the phone drops a page sent for one, so none is sent.
    /// A phone that names them, even as none, names all of them (#1381); one
    /// that leaves them out is judged by what it read a moment ago.
    #[serde(default)]
    open: Option<Vec<OpenTranscript>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenTranscript {
    session_id: String,
    tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KnownTranscript {
    session_id: String,
    tab_id: String,
    cursor: SyncCursor,
}

/// Starts sending, or stops, the newest part of the most recently active
/// conversations (#1283). The phone asks only when its person turned the
/// setting on, and stops it when it goes to the background: it spends the
/// phone's data. Each is a `session.sync` page as the phone would have read
/// it, from the checkpoint the phone named, or the newest part when it named
/// none; a conversation with nothing new is not sent.
fn prefetch(connection: &Arc<MobileConnection>, params: PrefetchParams) -> Result<Value> {
    if !params.enabled {
        connection.prefetch.stop();
        return Ok(json!({ "enabled": false }));
    }
    if params.known.len() > PREFETCH_KNOWN || params.open.as_ref().is_some_and(|open| open.len() > PREFETCH_KNOWN) {
        connection.prefetch.stop();
        bail!("a prefetch names at most {PREFETCH_KNOWN} conversations");
    }
    let open: Option<HashSet<(String, String)>> = params.open
        .map(|open| open.into_iter().map(|open| (open.session_id, open.tab_id)).collect());
    let known: HashMap<(String, String), SyncCursor> = params.known.into_iter()
        .map(|known| ((known.session_id, known.tab_id), known.cursor)).collect();
    // Replaces the one under way, if any: never more than one thread at work for a connection.
    connection.prefetch.submit(PrefetchJob { connection: Arc::downgrade(connection), known, open })?;
    Ok(json!({ "enabled": true, "sessions": PREFETCH_SESSIONS, "bytes": PREFETCH_BYTES }))
}

/// The conversations a `sync.prefetch` started now would send (#1339). A
/// phone keeps more conversations than it can name checkpoints for; it asks
/// this first and names the checkpoints of these, so a conversation it keeps
/// is sent from where its copy ends, not as a newest part it would drop. The
/// list is at most `PREFETCH_SESSIONS` × `PREFETCH_TABS_PER_SESSION` long.
fn prefetch_targets_reply() -> Result<Value> {
    let targets = prefetch_targets(index::load()?);
    Ok(json!({ "targets": targets.into_iter().map(|(session, tab)| json!({ "sessionId": session, "tabId": tab })).collect::<Vec<_>>() }))
}

/// What one `sync.prefetch` asked for.
struct PrefetchJob {
    connection: std::sync::Weak<MobileConnection>,
    known: HashMap<(String, String), SyncCursor>,
    /// None from a phone that does not name them.
    open: Option<HashSet<(String, String)>>,
}

/// Sends one `sync.prefetch`'s conversations, until it is done, no longer
/// `wanted`, or the connection closes. Each check comes before an expensive
/// step and before each send, and the log reads and hashes check as they go,
/// so a replaced prefetch reads and sends nothing more.
fn run_prefetch(job: PrefetchJob, wanted: &dyn Fn() -> bool) {
    use std::sync::atomic::Ordering;
    let current = |connection: &MobileConnection| !connection.closed.load(Ordering::SeqCst) && wanted();
    let targets = match index::load() {
        Ok(sessions) => prefetch_targets(sessions),
        Err(error) => { log::warn!("prefetch skipped: the session index did not load: {error:#}"); return; }
    };
    let mut sent = 0;
    for (session, tab) in targets {
        let Some(connection) = job.connection.upgrade() else { return };
        if PREFETCH_BYTES - sent < 16 * 1024 || !current(&connection) || !connection.room_for_prefetch(&current) { return; }
        if reading_for_itself(&connection.sync_cache, job.open.as_ref(), &session, &tab) { continue; }
        let after = job.known.get(&(session.clone(), tab.clone()));
        let still = || current(&connection);
        match prefetch_message(&connection, &session, &tab, after, PREFETCH_BYTES - sent, Wanted(&still)) {
            Ok(Some(message)) => {
                let size = serde_json::to_vec(&message).map_or(usize::MAX, |bytes| bytes.len());
                if size > PREFETCH_BYTES - sent || !current(&connection) { return; }
                // Room was made for it; a queue that filled since is left to live events.
                if connection.outbound.try_send(message).is_err() { return; }
                sent += size;
            }
            Ok(None) => {}
            Err(error) if error.is::<Stopped>() => return,
            Err(error) => log::debug!("prefetch of {session}/{tab} skipped: {error:#}"),
        }
        drop(connection);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Whether the phone reads this conversation for itself, so a prefetch leaves
/// it (#1337): it named it open; or, from a phone that names none, it read
/// it on this connection a moment ago, as one open on screen does. A phone's
/// own list is the whole of it (#1381): one it just closed is sent its new
/// events. The phone drops a page sent for an open one, and the data it
/// spent on that page is wasted.
fn reading_for_itself(cache: &SyncCache, open: Option<&HashSet<(String, String)>>, session: &str, tab: &str) -> bool {
    match open {
        Some(open) => open.contains(&(session.to_string(), tab.to_string())),
        None => cache.read_within(session, tab, PREFETCH_READING),
    }
}

/// The conversations a prefetch sends, most recently active first: the
/// newest tabs of the newest sessions that are not archived.
fn prefetch_targets(sessions: Vec<SessionEntry>) -> Vec<(String, String)> {
    let latest = |session: &SessionEntry| session.tabs.iter().map(|tab| tab.modified.as_str())
        .chain([session.modified.as_str()]).max().unwrap_or_default().to_string();
    let mut sessions: Vec<_> = sessions.into_iter().filter(|session| !session.archived).collect();
    sessions.sort_by_cached_key(|session| std::cmp::Reverse(latest(session)));
    sessions.into_iter().take(PREFETCH_SESSIONS).flat_map(|session| {
        let mut tabs = session.tabs;
        tabs.sort_by(|left, right| right.modified.cmp(&left.modified));
        tabs.into_iter().take(PREFETCH_TABS_PER_SESSION).map(move |tab| (session.id.clone(), tab.id))
    }).collect()
}

/// One conversation's `session.prefetch`, at most `budget` bytes of page;
/// `None` when the phone's checkpoint is already the end.
fn prefetch_message(connection: &MobileConnection, session: &str, tab: &str, after: Option<&SyncCursor>, budget: usize, wanted: Wanted) -> Result<Option<Value>> {
    let path = store::log_path(session, tab)?;
    // The wrapper around the page, at its largest, is left out of the page's room.
    let wrapper = serde_json::to_vec(&json!({ "method": "session.prefetch", "params": {
        "sessionId": session, "tabId": tab, "page": null,
        "after": SyncCursor { offset: usize::MAX, digest: "0".repeat(64) },
    } }))?.len();
    let limits = connection.wire.reply_limits(TAIL_RESPONSE_BYTES_LIMIT);
    let page_room = limits.page.min(PREFETCH_MESSAGE_BYTES).min(budget);
    let limits = ReplyLimits {
        page: page_room.checked_sub(wrapper).context("no room left for a prefetch")?,
        single: limits.single.min(budget).checked_sub(wrapper).context("no room left for a prefetch")?,
    };
    // Kept apart from the phone reader's checkpoint (#1337): the phone may drop this page.
    let page = synced_page_while((&connection.sync_cache, Reader::Prefetch), &path, after, session, tab, "prefetch", limits, wanted)?;
    if page["reset"] == false && page["events"].as_array().is_some_and(Vec::is_empty) {
        return Ok(None);
    }
    Ok(Some(json!({ "method": "session.prefetch", "params": { "sessionId": session, "tabId": tab, "after": after, "page": page } })))
}

impl MobileConnection {
    /// Waits until at least half the connection's queue is free, so a
    /// prefetch never takes the room a live event needs: a full queue drops
    /// the connection. False when it stopped being wanted, or never freed.
    fn room_for_prefetch(&self, current: &dyn Fn(&MobileConnection) -> bool) -> bool {
        let started = std::time::Instant::now();
        while self.outbound.capacity() * 2 < self.outbound.max_capacity() {
            if !current(self) || started.elapsed() > PREFETCH_ROOM_WAIT { return false; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        true
    }
}

/// How many of `events` fill a page. The first is always taken: one larger
/// than a page on its own is the whole page.
fn sync_event_count<'a>(events: impl Iterator<Item = &'a AgentEvent>, budget: usize) -> Result<usize> {
    let mut count = 0;
    let mut bytes = 0;
    for event in events {
        let size = serde_json::to_vec(event)?.len() + usize::from(count > 0);
        if count > 0 && bytes + size > budget {
            break;
        }
        bytes += size;
        count += 1;
    }
    Ok(count)
}

/// The note that ends a string cut short to fit.
fn cut_note(omitted: usize) -> String {
    crate::platform_profile::localize(&format!("\n\n[Too large to show on mobile: {} not shown. Open this conversation on your Mac to see all of it.]", megabytes(omitted)))
}

/// An event as JSON of at most `budget` bytes (#669). In one that is larger,
/// the longest strings are cut short, longest first, each ending in a note of
/// what is missing. Everything else about the event is kept, so the phone
/// still pairs a tool's result with its call. One made of many small parts
/// becomes a status line saying it is too large.
fn fit_event(event: &AgentEvent, budget: usize) -> Result<Value> {
    let mut value = serde_json::to_value(event)?;
    let size = serde_json::to_vec(&value)?.len();
    if size <= budget {
        return Ok(value);
    }
    // No cut omits more than the whole event, so no note is longer than this.
    let note = json_escaped_len(&cut_note(size));
    let mut excess = size - budget;
    {
        let mut strings = Vec::new();
        if let Some(payload) = value.get_mut("payload") {
            strings_mut(payload, &mut strings);
        }
        let mut strings: Vec<_> = strings.into_iter().map(|text| (json_escaped_len(text), text)).collect();
        strings.sort_by_key(|(length, _)| std::cmp::Reverse(*length));
        for (length, text) in strings {
            if excess == 0 || length <= note {
                break;
            }
            let keep = length.saturating_sub(excess + note);
            excess = excess.saturating_sub(length - keep - note);
            let end = escaped_prefix_end(text, keep);
            let omitted = text.len() - end;
            text.truncate(end);
            text.push_str(&cut_note(omitted));
        }
    }
    if excess > 0 || serde_json::to_vec(&value)?.len() > budget {
        value["payload"] = json!({
            "type": "status",
            "text": crate::platform_profile::localize(&format!("This item is too large to show on mobile ({}). Open this conversation on your Mac to see it.", megabytes(size))),
        });
    }
    Ok(value)
}

fn strings_mut<'a>(value: &'a mut Value, found: &mut Vec<&'a mut String>) {
    match value {
        Value::String(text) => found.push(text),
        Value::Array(items) => items.iter_mut().for_each(|item| strings_mut(item, found)),
        Value::Object(fields) => fields.values_mut().for_each(|item| strings_mut(item, found)),
        _ => {}
    }
}

/// The bytes `c` takes inside a JSON string, as serde_json writes it.
fn escaped_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
        '\0'..='\u{1f}' => 6,
        c => c.len_utf8(),
    }
}

fn json_escaped_len(text: &str) -> usize {
    text.chars().map(escaped_len).sum()
}

/// Where the longest prefix of `text` that escapes to at most `limit` bytes ends.
fn escaped_prefix_end(text: &str, limit: usize) -> usize {
    let mut used = 0;
    for (index, c) in text.char_indices() {
        used += escaped_len(c);
        if used > limit {
            return index;
        }
    }
    text.len()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionTailParams {
    session_id: String,
    tab_id: String,
    #[serde(default)]
    before: Option<u64>,
    limit: usize,
}

fn session_tail(connection: &MobileConnection, request_id: &str, params: SessionTailParams) -> Result<Value> {
    validate_session_tab(&params.session_id, &params.tab_id)?;
    if !(1..=20).contains(&params.limit) {
        bail!("tail limit must be between 1 and 20 turns");
    }
    let path = store::log_path(&params.session_id, &params.tab_id)?;
    let limits = connection.wire.reply_limits(TAIL_RESPONSE_BYTES_LIMIT);
    let byte_limit = tail_event_byte_limit(request_id, limits.page)?;
    let single = tail_event_byte_limit(request_id, limits.single)?;
    if params.before.is_none() {
        connection.call("reconcile", json!({"sessionId":params.session_id,"tabId":params.tab_id}))?;
    }
    let (events, has_more) = read_event_tail(&path, params.before, params.limit, byte_limit)?;
    let events = events.iter().map(|event| fit_event(event, single)).collect::<Result<Vec<_>>>()?;
    Ok(json!({ "events": events, "hasMore": has_more }))
}

fn tail_event_byte_limit(request_id: &str, response_limit: usize) -> Result<usize> {
    // `false` is longer than `true`; count the request id after JSON escaping too.
    let envelope = success_response(request_id, json!({ "events": [], "hasMore": false }));
    response_limit.checked_sub(serde_json::to_vec(&envelope)?.len())
        .context("transcript request envelope is too large")
}

fn read_event_tail(path: &Path, before: Option<u64>, turn_limit: usize, byte_limit: usize) -> Result<(Vec<AgentEvent>, bool)> {
    let mut lines = match summaries::TailLines::open_unbounded(path) {
        Ok(lines) => lines,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(error) => return Err(error.into()),
    };
    select_event_tail(std::iter::from_fn(|| next_tail_event(&mut lines).transpose()), before, turn_limit, byte_limit)
}

/// Read newest first and return a contiguous suffix in sequence order. Limits may split a turn;
/// the first returned sequence remains the exclusive `before` cursor for the
/// next page. Never skip an event to make a page fit: one larger than a page
/// on its own is the whole page, for the caller to cut down if it must.
fn select_event_tail(
    source: impl IntoIterator<Item = Result<AgentEvent>>,
    before: Option<u64>,
    turn_limit: usize,
    byte_limit: usize,
) -> Result<(Vec<AgentEvent>, bool)> {
    let mut events = Vec::new();
    let mut turns = 0usize;
    let mut has_more = false;
    let mut bytes = 0usize;
    for event in source {
        let event = event?;
        if before.is_some_and(|before| event.seq >= before) {
            continue;
        }
        if turns >= turn_limit || events.len() >= TAIL_EVENT_LIMIT {
            has_more = true;
            break;
        }
        let event_bytes = serde_json::to_vec(&event)?.len() + usize::from(!events.is_empty());
        if !events.is_empty() && bytes + event_bytes > byte_limit {
            has_more = true;
            break;
        }
        bytes += event_bytes;
        let is_prompt = matches!(event.payload, Payload::UserMessage { .. });
        events.push(event);
        if is_prompt {
            turns += 1;
        }
    }
    events.reverse();
    Ok((events, has_more))
}

fn next_tail_event(lines: &mut summaries::TailLines) -> Result<Option<AgentEvent>> {
    loop {
        let Some(line) = lines.next_line()? else { return Ok(None) };
        if let Ok(event) = serde_json::from_str(&line) {
            return Ok(Some(event));
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSubscribeParams {
    tab_id: String,
}

fn subscribe_session(
    sink: &dyn EventSink,
    connection: &Arc<MobileConnection>,
    request_id: &str,
    params: SessionSubscribeParams,
) -> Result<Value> {
    let (session, _) = find_tab(&params.tab_id)?;
    let subscription_id = Uuid::new_v4().to_string();
    let stream = Arc::downgrade(connection);
    let response_id = request_id.to_string();
    let session_id = session.id;
    let tab_id = params.tab_id;
    let listener = sink.listen(
        "agent_event",
        Box::new(move |payload| {
            let Ok(event) = serde_json::from_str::<AgentEvent>(payload) else { return };
            if event.session_id == session_id && event.tab_id == tab_id {
                if let Some(stream) = stream.upgrade() {
                    let _ = stream.stream_event(&response_id, &event);
                }
            }
        }),
    );
    connection.insert_subscription(subscription_id.clone(), listener);
    Ok(json!({ "subscriptionId": subscription_id }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnsubscribeParams {
    subscription_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteAttachmentInput {
    media_type: String,
    data: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSendParams {
    tab_id: String,
    text: String,
    #[serde(default)]
    attachments: Vec<RemoteAttachmentInput>,
    /// The phone's id for this draft; sent only to a Mac with `sendIds` (#675).
    #[serde(default)]
    client_message_id: Option<String>,
}

fn send_session(manager: &PhoneHost, connection: &MobileConnection, params: SessionSendParams) -> Result<Value> {
    send_once(&manager.mobile.send_ids, params, |tab_id, text, attachments, message| {
        let (session, _) = find_tab(tab_id)?;
        send_attributed(connection, &session.id, tab_id, text, attachments, message)
    })
}

/// A phone's send, once per message id (#675). `owner_send` is the
/// runtime's send, given the id too: a queued send is answered by the
/// runtime on every repeat, since only it knows where that copy is.
fn send_once(
    ids: &SendIds,
    params: SessionSendParams,
    owner_send: impl FnOnce(&str, &str, Vec<RemoteAttachmentInput>, Option<&str>) -> Result<OwnerSend>,
) -> Result<Value> {
    let SessionSendParams { tab_id, text, attachments, client_message_id } = params;
    let Some(id) = checked_message_id(client_message_id)? else {
        return Ok(settle(owner_send(&tab_id, &text, attachments, None)?)?.into_value());
    };
    let digest = send_digest(&text, &attachments);
    let key = SendKey { tab_id: tab_id.clone(), client_message_id: id.clone() };
    ids.once(key, digest, || settle(owner_send(&tab_id, &text, attachments, Some(&id))?))
}

/// The phone's reply to what the runtime made of a send.
fn settle(sent: OwnerSend) -> Result<Reply> {
    // The first copy is being typed to the agent right now. The draft keeps
    // its id, so the next try learns whether it arrived.
    if sent.repeat == Some(Repeat::Delivering) {
        bail!("{}", crate::platform_profile::localize(STILL_SENDING));
    }
    let reply = json!({ "status": "sent", "queued": sent.outcome.queued });
    // A queued copy is dropped if the connection it came over closes before
    // the agent's turn ends, and that is the connection whose drop lost this
    // reply. So a queued reply answers no repeat: each goes to the runtime,
    // which delivers, re-queues or reports that copy instead of adding one.
    Ok(if sent.outcome.queued { Reply::Unsettled(reply) } else { Reply::Settled(reply) })
}

/// The runtime's answer to a send: its outcome and, for a phone message sent
/// again, what it found of the first copy (#675). An older runtime ignores the
/// id and never reports `repeat`; its outcome reads as it always has.
#[derive(Deserialize)]
struct OwnerSend {
    #[serde(flatten)]
    outcome: crate::session::SendOutcome,
    #[serde(default)]
    repeat: Option<Repeat>,
}

/// The id a phone gave a message (#675): a UUID, held to what fits a key.
fn checked_message_id(id: Option<String>) -> Result<Option<String>> {
    match id {
        Some(id) if !(8..=128).contains(&id.len()) || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') => {
            bail!("invalid client message id")
        }
        id => Ok(id),
    }
}

/// What a send carries, as the agent gets it: trimmed text and every
/// attachment whole. Equal for a repeat, different for any edit.
fn send_digest(text: &str, attachments: &[RemoteAttachmentInput]) -> String {
    let attachments: Vec<_> = attachments
        .iter()
        .map(|attachment| json!([attachment.media_type, attachment.name, attachment.data]))
        .collect();
    let canonical = serde_json::to_vec(&json!([text.trim(), attachments])).expect("a JSON value serializes");
    format!("{:x}", Sha256::digest(canonical))
}

/// What the desktop's new-session view lets a person choose, for a phone to
/// choose the same: projects (by an id that is not their path), the agents
/// with their models and efforts, and the permission modes. With `runtime`
/// starting sessions on an agent account (#980), each agent with several
/// accounts also lists them, to a device that may start sessions (`driver`):
/// a read-only phone cannot choose one, so it is not told their labels.
fn new_session_options(manager: &PhoneHost, runtime: &crate::local_runtime::client::Build, driver: bool) -> Result<Value> {
    let projects = phone_projects()?;
    let codex = manager.mobile.codex_models.get().map(|cache| cache.get(false)).unwrap_or_default();
    let models = crate::models::offered(crate::harness::claude::models::get(false), codex);
    let offered: HashSet<String> = projects.iter().filter_map(|project| project["id"].as_str().map(str::to_string)).collect();
    let lists_accounts = driver && serves_accounts(runtime);
    let agents: Vec<Value> = crate::harness::offered().into_iter().map(|agent| {
        let models: Vec<Value> = models.iter().filter(|model| model.harness == agent.id).map(|model| json!({
            "id": model.id, "label": model.label, "isDefault": model.is_default,
            "efforts": model.efforts, "defaultEffort": model.default_effort,
        })).collect();
        let mut entry = json!({"id": agent.id, "name": agent.name, "available": agent.available, "installHint": agent.install_hint,
            "effort": agent.caps.effort, "permissionModes": agent.caps.permission_modes, "models": models});
        // An agent without accounts, or whose index cannot be read, offers no choice: the phone starts it as before accounts.
        // Nor does a runtime that would not start the session on the account chosen (#730): the choice would be lost.
        if let Some(accounts) = lists_accounts.then(|| crate::agent_accounts::list(&agent.id).ok()).flatten().and_then(|view| phone_accounts(&view, &offered)) {
            entry.as_object_mut().expect("an object").extend(accounts.as_object().expect("an object").clone());
        }
        entry
    }).collect();
    // As the desktop labels them (`PERMISSION_MODES`).
    let modes = json!([
        {"id": "plan", "label": "Plan"}, {"id": "manual", "label": "Ask every time"}, {"id": "auto", "label": "Auto"},
        {"id": "acceptEdits", "label": "Accept edits"}, {"id": "bypassPermissions", "label": "Bypass permissions"},
    ]);
    // The phone cannot see the mode the reader last picked on the Mac (it is
    // the webview's to keep), so its form opens where a fresh profile's New
    // Session does: Ask every time, never Bypass unasked (PRO-162).
    Ok(json!({"projects": projects, "agents": agents, "modes": modes, "defaultMode": index::FIRST_RUN_PERMISSION_MODE,
        "nativeCodex": store::settings::load().experimental.native_codex}))
}

/// The runtime feature that says `create` takes an `account` and starts the
/// session's first tab on it (#980). The phone is listed accounts only when
/// the runtime its connection reaches names it, so a choice is never offered
/// and then dropped by a runtime that starts every session on the defaults.
const SESSION_ACCOUNTS: &str = "sessionAccounts";

fn serves_accounts(runtime: &crate::local_runtime::client::Build) -> bool {
    runtime.mobile.get(SESSION_ACCOUNTS).and_then(Value::as_u64).is_some_and(|served| served >= 1)
}

/// An agent's accounts as a phone sees them (#980, docs/AGENT-ACCOUNTS.md):
/// only when it has more than one, so with one nothing in the reply changes.
/// Each is its id, label and agent, and nothing else: never a token, and no
/// address, plan or organization beyond what its label says. The project
/// defaults are keyed by the projects' public ids (never a path), and only for
/// projects in `offered`.
fn phone_accounts(view: &crate::agent_accounts::AgentAccounts, offered: &HashSet<String>) -> Option<Value> {
    if view.accounts.len() < 2 {
        return None;
    }
    let accounts: Vec<Value> = view.accounts.iter()
        // A sign-in deleted outside the app cannot start a session until it is signed in again on the Mac.
        .filter(|account| !account.missing)
        .map(|account| json!({"id": account.id, "label": account.label, "agent": account.agent}))
        .collect();
    let listed = |id: &str| accounts.iter().any(|account| account["id"] == id);
    let project_defaults: serde_json::Map<String, Value> = view.project_defaults.iter()
        .map(|(path, id)| (store::projects::public_id(path), id))
        .filter(|(project, id)| offered.contains(project) && listed(id))
        .map(|(project, id)| (project, Value::String(id.clone())))
        .collect();
    let default = if listed(&view.default_account) { view.default_account.as_str() } else { crate::agent_accounts::LOCAL };
    Some(json!({"accounts": accounts, "defaultAccount": default, "projectDefaults": project_defaults}))
}

/// The projects a phone may start a session in: not archived, named, and
/// known by an id that is not their path.
fn phone_projects() -> Result<Vec<Value>> {
    let (projects, last) = store::projects::list()?;
    Ok(projects.iter().filter(|project| !project.archived).map(|project| json!({
        "id": store::projects::public_id(&project.path),
        "name": project.name,
        "git": project.kind == store::projects::ProjectKind::Git,
        "repositorySettings": project.repository_settings,
        "lastUsed": last.as_deref() == Some(project.path.as_str()),
    })).collect())
}

/// Where a new session's id is remembered for a repeat (#675): never a tab's.
const NEW_SESSION_KEY: &str = "new-session";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionCreateParams {
    #[serde(default)]
    quick: bool,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    use_worktree: bool,
    agent: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    title: Option<String>,
    /// The first message, sent to the new session as the phone sends any.
    text: String,
    #[serde(default)]
    attachments: Vec<RemoteAttachmentInput>,
    #[serde(default)]
    client_message_id: Option<String>,
    /// The agent account the session starts on (#980), one `sessions.options` listed. Absent: the project's default, then the agent's.
    #[serde(default)]
    account: Option<String>,
}

/// Start a session from the phone, then send it the first message through
/// the phone's own send. With a `clientMessageId`, a repeat after a lost reply
/// finds the session the first try made instead of making another, and its
/// message is answered once as any send is. A first message that could not be
/// sent leaves the session, and says why, for the phone to open and retry.
fn create_session(manager: &PhoneHost, connection: &MobileConnection, params: SessionCreateParams) -> Result<Value> {
    if params.text.trim().is_empty() && params.attachments.is_empty() {
        bail!("A new session needs a first message.");
    }
    let message = checked_message_id(params.client_message_id.clone())?;
    let account = crate::session_ops::requested_account(params.account.as_deref()).map_err(|error| anyhow::anyhow!(error))?;
    // A runtime that does not start sessions on an account would start this one on the defaults instead.
    if account.is_some() && !serves_accounts(connection.owner.build()) {
        bail!("{}", crate::platform_profile::localize(OUTDATED));
    }
    let mut request = json!({"quick": params.quick, "projectId": params.project_id, "useWorktree": params.use_worktree,
        "agent": params.agent, "model": params.model, "effort": params.effort, "mode": params.mode,
        "title": params.title, "prompt": params.text});
    // Only a chosen account is named, so a start without one asks the runtime exactly what it always did.
    if let Some(account) = account {
        request["account"] = Value::String(account);
    }
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&json!([&request, send_digest(&params.text, &params.attachments)]))?));
    let created = create_once(&manager.mobile.send_ids, message.as_deref(), digest, || connection.call("create", request.clone()))?;
    let session_id = created["sessionId"].as_str().context("The Mac did not say which session it started.")?.to_string();
    let tab_id = created["tabId"].as_str().context("The Mac did not say which session it started.")?.to_string();
    let first = SessionSendParams { tab_id: tab_id.clone(), text: params.text, attachments: params.attachments, client_message_id: message };
    let sent = match send_session(manager, connection, first) {
        Ok(reply) => json!({"sent": reply}),
        Err(error) => json!({"sendError": format!("{error:#}")}),
    };
    let mut reply = json!({"sessionId": session_id, "tabId": tab_id, "title": created["title"], "native": created["native"]});
    reply.as_object_mut().expect("an object").extend(sent.as_object().expect("an object").clone());
    Ok(reply)
}

/// The session a phone's create made, made once per message id (#675): a
/// repeat of the same request gets the first session, and the id with another
/// request is refused. Without an id, each request makes one.
fn create_once(ids: &SendIds, message: Option<&str>, digest: String, create: impl FnOnce() -> Result<Value>) -> Result<Value> {
    match message {
        None => create(),
        Some(id) => {
            let key = SendKey { tab_id: NEW_SESSION_KEY.into(), client_message_id: id.into() };
            ids.once(key, digest, || Ok(Reply::Settled(create()?)))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MacSettingsPatch {
    native_codex: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionRespondParams {
    session_id: String,
    tab_id: String,
    request_id: String,
    option_id: String,
}

fn respond_permission(connection: &MobileConnection, params: PermissionRespondParams) -> Result<Value> {
    connection.call("permission", json!({"sessionId":params.session_id,"tabId":params.tab_id,
        "requestId":params.request_id,"optionId":params.option_id}))
}

/// An agent's question answered from the phone (#979). `answers` is what the
/// desktop's card sends: each question's text to its answer, a multi-select
/// answer being the chosen labels joined with ", ". Empty, it is a skip.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuestionsRespondParams {
    session_id: String,
    tab_id: String,
    request_id: String,
    answers: std::collections::HashMap<String, String>,
}

fn respond_questions(connection: &MobileConnection, params: QuestionsRespondParams) -> Result<Value> {
    connection.call("questions", json!({"sessionId":params.session_id,"tabId":params.tab_id,
        "requestId":params.request_id,"answers":params.answers}))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatNote {
    id: String,
    body: String,
    created_at: i64,
    author: NoteAuthor,
    /// The agent messages this note was sent as, one per tab (#541). That
    /// tab's transcript shows the text as its user message, so a client
    /// leaves the note out of that tab's conversation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    promoted_to: Vec<NotePromotion>,
    /// The phone's id for the draft this note was posted from (#675). The
    /// same draft posted again finds this note instead of adding another.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotePromotion {
    tab_id: String,
    /// The `seq` of the tab's `UserMessage` that carried the note.
    seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteAuthor {
    user_id: String,
    display_name: String,
}

#[derive(Default, Serialize, Deserialize)]
struct NotesFile {
    #[serde(default)]
    sessions: HashMap<String, Vec<ChatNote>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatListParams {
    version: Option<String>,
    worktree_id: String,
    limit: usize,
}

fn list_notes(manager: &PhoneHost, params: ChatListParams) -> Result<Value> {
    index::get(&params.worktree_id)?;
    if !(1..=100).contains(&params.limit) {
        bail!("chat limit must be between 1 and 100");
    }
    let _guard = manager.mobile.notes.lock().unwrap();
    let mut notes = load_notes()?
        .sessions
        .remove(&params.worktree_id)
        .unwrap_or_default();
    if notes.len() > params.limit {
        notes.drain(..notes.len() - params.limit);
    }
    conditional(json!({ "messages": notes }), params.version)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatPostParams {
    worktree_id: String,
    body: String,
    /// The phone's id for this draft; sent only to a Mac with `sendIds` (#675).
    #[serde(default)]
    client_message_id: Option<String>,
}

fn post_note(manager: &PhoneHost, device: &DeviceEntry, params: ChatPostParams) -> Result<Value> {
    index::get(&params.worktree_id)?;
    let body = validate_note(&params.body)?;
    let client_message_id = checked_message_id(params.client_message_id)?;
    let author = effective_user(device)?;
    let note = ChatNote {
        id: Uuid::now_v7().to_string(),
        body,
        created_at: Utc::now().timestamp_millis(),
        author,
        promoted_to: Vec::new(),
        client_message_id,
    };
    let (note, added) = add_note(&manager.mobile.notes, &params.worktree_id, note)?;
    if added {
        manager.mobile.broadcast(json!({
            "method": "chat.changed",
            "params": { "worktreeId": params.worktree_id },
        }));
    }
    Ok(json!({ "status": "sent", "message": note }))
}

/// Add `note` to its worktree's notes, unless its draft was already posted
/// (#675): then that note, and false. Looked up under the same lock that
/// adds notes, so two tries of one draft cannot both miss each other.
fn add_note(lock: &Mutex<()>, worktree_id: &str, note: ChatNote) -> Result<(ChatNote, bool)> {
    let _guard = lock.lock().unwrap();
    let mut file = load_notes()?;
    let notes = file.sessions.entry(worktree_id.to_string()).or_default();
    if let Some(earlier) = posted_before(notes, &note)? {
        return Ok((earlier.clone(), false));
    }
    notes.push(note.clone());
    if notes.len() > NOTES_LIMIT {
        notes.drain(..notes.len() - NOTES_LIMIT);
    }
    save_notes(&file)?;
    Ok((note, true))
}

/// The note this draft was already posted as, if it was (#675): returned as
/// it is now, promotions included, as if the first reply had arrived. The id
/// with other text is refused rather than answered with the wrong note.
fn posted_before<'a>(notes: &'a [ChatNote], note: &ChatNote) -> Result<Option<&'a ChatNote>> {
    let Some(id) = &note.client_message_id else { return Ok(None) };
    let Some(earlier) = notes.iter().find(|earlier| earlier.client_message_id.as_ref() == Some(id)) else {
        return Ok(None);
    };
    if earlier.body != note.body {
        bail!("{}", crate::platform_profile::localize(ID_REUSED));
    }
    Ok(Some(earlier))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatPromoteParams {
    worktree_id: String,
    tab_id: String,
    message_ids: Vec<String>,
    #[serde(default)]
    attachments: Vec<RemoteAttachmentInput>,
}

fn promote_notes(manager: &PhoneHost, connection: &MobileConnection, params: ChatPromoteParams) -> Result<Value> {
    validate_session_tab(&params.worktree_id, &params.tab_id)?;
    if params.message_ids.is_empty() || params.message_ids.len() > 20 {
        bail!("promotion must name between 1 and 20 notes");
    }
    let wanted: HashSet<_> = params.message_ids.iter().collect();
    if wanted.len() != params.message_ids.len() {
        bail!("promotion contains duplicate note ids");
    }
    let _guard = manager.mobile.notes.lock().unwrap();
    let file = load_notes()?;
    let notes = file.sessions.get(&params.worktree_id).cloned().unwrap_or_default();
    let by_id: HashMap<_, _> = notes.into_iter().map(|note| (note.id.clone(), note)).collect();
    let mut text = Vec::new();
    for id in &params.message_ids {
        let note = by_id.get(id).ok_or_else(|| anyhow!("note no longer exists"))?;
        text.push(note.body.clone());
    }
    drop(_guard);
    let outcome = send_attributed(connection, &params.worktree_id, &params.tab_id, &text.join("\n\n"), params.attachments, None)?.outcome;
    let message = outcome.events.iter().find(|event| matches!(event.payload, Payload::UserMessage { .. }));
    if let Some(message) = message {
        let promotion = NotePromotion { tab_id: params.tab_id.clone(), seq: message.seq };
        // The agent has the message now. Failing to record that must not
        // read as a failed send, or the phone would offer to send it again.
        match record_promotion(manager, &params.worktree_id, &wanted, &promotion) {
            Ok(true) => manager.mobile.broadcast(json!({
                "method": "chat.changed",
                "params": { "worktreeId": params.worktree_id },
            })),
            Ok(false) => {}
            Err(error) => log::warn!("record note promotion for {}: {error:#}", params.worktree_id),
        }
    }
    Ok(json!({ "status": "sent", "queued": outcome.queued }))
}

fn record_promotion(manager: &PhoneHost, worktree_id: &str, ids: &HashSet<&String>, promotion: &NotePromotion) -> Result<bool> {
    let _guard = manager.mobile.notes.lock().unwrap();
    let mut file = load_notes()?;
    let Some(notes) = file.sessions.get_mut(worktree_id) else { return Ok(false) };
    if !mark_promoted(notes, ids, promotion) {
        return Ok(false);
    }
    save_notes(&file)?;
    Ok(true)
}

/// Note on each of `ids` that it went to the agent as `promotion`, replacing
/// an earlier promotion to the same tab so the list stays one per tab. A
/// note trimmed away while the message was sent is skipped.
fn mark_promoted(notes: &mut [ChatNote], ids: &HashSet<&String>, promotion: &NotePromotion) -> bool {
    let mut changed = false;
    for note in notes.iter_mut().filter(|note| ids.contains(&note.id)) {
        note.promoted_to.retain(|earlier| earlier.tab_id != promotion.tab_id);
        note.promoted_to.push(promotion.clone());
        changed = true;
    }
    changed
}

fn send_attributed(
    connection: &MobileConnection,
    session_id: &str,
    tab_id: &str,
    text: &str,
    attachments: Vec<RemoteAttachmentInput>,
    message: Option<&str>,
) -> Result<OwnerSend> {
    validate_session_tab(session_id, tab_id)?;
    let text = text.trim();
    if text.is_empty() && attachments.is_empty() {
        bail!("message must contain text or an attachment");
    }
    if !text.is_empty() {
        validate_note(text)?;
    }
    let (images, paths) = prepare_attachments(session_id, attachments)?;
    let mut prompt = text.to_string();
    for path in paths {
        if !prompt.is_empty() {
            prompt.push(' ');
        }
        prompt.push('@');
        prompt.push_str(&path);
    }
    let mut params = json!({"sessionId":session_id,"tabId":tab_id,"text":text,"prompt":prompt,"images":images});
    if let Some(message) = message {
        params["clientMessageId"] = json!(message);
    }
    serde_json::from_value(connection.call("send", params)?).context("Invalid owner send result")
}

fn prepare_attachments(session_id: &str, attachments: Vec<RemoteAttachmentInput>) -> Result<(Vec<crate::session::ImageInput>, Vec<String>)> {
    let decoded = validate_attachment_payloads(&attachments)?;
    let mut images = Vec::new();
    let mut paths = Vec::new();
    for (attachment, bytes) in attachments.into_iter().zip(decoded) {
        if matches!(attachment.media_type.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
            images.push(crate::session::ImageInput { media_type: attachment.media_type, data: attachment.data, name: attachment.name });
            continue;
        }
        let name = safe_attachment_name(attachment.name.as_deref());
        let path = store::attachments_dir(session_id)?.join(format!("{}-{name}", Uuid::now_v7()));
        std::fs::write(&path, bytes)?;
        paths.push(path.to_string_lossy().into_owned());
    }
    Ok((images, paths))
}

fn validate_attachment_payloads(attachments: &[RemoteAttachmentInput]) -> Result<Vec<Vec<u8>>> {
    if attachments.len() > ATTACHMENT_COUNT_LIMIT {
        bail!("a message may contain at most {ATTACHMENT_COUNT_LIMIT} attachments");
    }
    let mut total = 0usize;
    let mut decoded = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        if attachment.media_type.is_empty() || attachment.media_type.len() > 127 || !attachment.media_type.is_ascii() {
            bail!("invalid attachment type");
        }
        if attachment.name.as_ref().is_some_and(|name| name.len() > 255) {
            bail!("attachment name is too long");
        }
        let bytes = general_purpose::STANDARD
            .decode(&attachment.data)
            .context("attachment is not valid base64")?;
        total = total.checked_add(bytes.len()).context("attachment size overflow")?;
        if total > ATTACHMENT_BYTES_LIMIT {
            bail!("attachments may total at most 5 MB");
        }
        decoded.push(bytes);
    }
    Ok(decoded)
}

fn safe_attachment_name(name: Option<&str>) -> String {
    let name = name
        .and_then(|name| Path::new(name).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("attachment");
    name.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') { ch } else { '_' })
        .collect()
}

fn validate_note(body: &str) -> Result<String> {
    let body = body.trim();
    if body.is_empty() || body.len() > NOTE_BYTES_LIMIT {
        bail!("message must contain 1 to {NOTE_BYTES_LIMIT} bytes");
    }
    Ok(body.into())
}

fn effective_user(device: &DeviceEntry) -> Result<NoteAuthor> {
    effective_user_from_mirror(device, account_mirror()?)
}

fn effective_user_from_mirror(device: &DeviceEntry, mirror: Option<AccountMirror>) -> Result<NoteAuthor> {
    let Some(mirror) = mirror else {
        if device.provenance != DeviceProvenance::Explicit || device.bound_user_id.is_some() {
            bail!("host identity is unavailable");
        }
        return Ok(NoteAuthor {
            user_id: device.id.clone(),
            display_name: if device.label.trim().is_empty() {
                "Paired mobile device".into()
            } else {
                device.label.clone()
            },
        });
    };
    if device
        .bound_user_id
        .as_ref()
        .is_some_and(|user_id| user_id != &mirror.user_id)
    {
        bail!("paired-device identity no longer matches the host");
    }
    Ok(NoteAuthor {
        user_id: mirror.user_id,
        display_name: if mirror.display_name.trim().is_empty() {
            mirror.email
        } else {
            mirror.display_name
        },
    })
}

fn notes_path() -> Result<std::path::PathBuf> {
    Ok(store::root()?.join("mobile-notes.json"))
}

fn load_notes() -> Result<NotesFile> {
    Ok(store::read_json(&notes_path()?)?.unwrap_or_default())
}

fn save_notes(file: &NotesFile) -> Result<()> {
    store::write_json(&notes_path()?, file)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalParams {
    worktree_id: String,
    tab_id: String,
}

fn read_terminal(connection: &MobileConnection, params: TerminalParams) -> Result<Value> {
    connection.call("terminalRead", json!({"sessionId":params.worktree_id,"tabId":params.tab_id}))
}

/// Opening a tab's terminal view from the phone, as the desktop's terminal
/// toggle does: the tab's agent is started in its terminal if it is not
/// running, and a native Codex tab moves to Codex's own terminal for good.
fn open_terminal(connection: &MobileConnection, params: TerminalParams) -> Result<Value> {
    connection.call("openTerminal", json!({"sessionId":params.worktree_id,"tabId":params.tab_id}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalSubscribeParams {
    worktree_id: String,
    tab_id: String,
    attach_mode: String,
    client: Value,
    capabilities: Value,
}

fn subscribe_terminal(connection: &Arc<MobileConnection>, request_id: &str, params: TerminalSubscribeParams) -> Result<Value> {
    let result = connection.call("observe",json!({"sessionId":params.worktree_id,"tabId":params.tab_id,
        "attachMode":params.attach_mode,"client":params.client,"capabilities":params.capabilities}))?;
    let id = result["subscriptionId"].as_str().context("Owner returned no terminal subscription.")?.to_string();
    connection.terminal_subscriptions.lock().unwrap().insert(id,request_id.into());
    connection.start_polling()?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueInputParams {
    worktree_id: String,
    tab_id: String,
    text: String,
}

fn queue_input(connection: &MobileConnection, params: QueueInputParams) -> Result<Value> {
    if params.text.is_empty() || params.text.len() > INPUT_BYTES_LIMIT { bail!("terminal input must contain 1 to {INPUT_BYTES_LIMIT} bytes"); }
    connection.call("input",json!({"sessionId":params.worktree_id,"tabId":params.tab_id,"text":params.text}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseInputParams {
    worktree_id: String,
    tab_id: String,
}

fn release_input(connection: &MobileConnection, params: ReleaseInputParams) -> Result<Value> {
    connection.call("release",json!({"sessionId":params.worktree_id,"tabId":params.tab_id}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MissedNotificationsParams {
    last_seen_seq: u64,
    #[serde(default)]
    epoch: Option<String>,
    #[serde(default)]
    filter: Option<NotificationFilter>,
}

fn missed_notifications(manager: &PhoneHost, params: MissedNotificationsParams) -> Value {
    json!({
        "epoch": manager.mobile.notification_epoch,
        "events": manager
            .mobile
            .missed_notifications(params.epoch.as_deref(), params.last_seen_seq, params.filter.as_ref()),
    })
}

/// Empty, as every phone before filters sends it: every notice.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscribeNotificationsParams {
    #[serde(default)]
    filter: Option<NotificationFilter>,
}

fn subscribe_notifications(
    sink: &dyn EventSink,
    connection: &Arc<MobileConnection>,
    request_id: &str,
    params: SubscribeNotificationsParams,
) -> Result<Value> {
    let subscription_id = Uuid::new_v4().to_string();
    let stream = Arc::downgrade(connection);
    let response_id = request_id.to_string();
    let listener = listen_notifications(sink, &connection.notification_filter, &subscription_id, params.filter, move |result| {
        if let Some(stream) = stream.upgrade() { stream.stream(&response_id, result); }
    });
    connection.insert_subscription(subscription_id.clone(), listener);
    Ok(json!({ "subscriptionId": subscription_id }))
}

/// A subscription's stream: each notice its filter admits, to `deliver`, and
/// the filter kept as the connection's (`slot`), which `notifications.event`
/// is held to as well.
fn listen_notifications(
    sink: &dyn EventSink,
    slot: &ConnectionFilter,
    subscription_id: &str,
    filter: Option<NotificationFilter>,
    deliver: impl Fn(Value) + Send + Sync + 'static,
) -> ListenerId {
    *slot.lock().unwrap() = filter.clone().map(|filter| (subscription_id.to_string(), filter));
    sink.listen("mobile_notification", Box::new(move |payload| {
        let Ok(event) = serde_json::from_str::<MobileNotification>(payload) else { return };
        if admitted(filter.as_ref(), &event) { deliver(json!({ "event": event })); }
    }))
}

/// The connection's filter, cleared when the subscription that named it ends;
/// a later subscription's is kept.
fn forget_filter(slot: &ConnectionFilter, subscription_id: &str) {
    let mut filter = slot.lock().unwrap();
    if filter.as_ref().is_some_and(|(id, _)| id == subscription_id) { *filter = None; }
}

fn validate_session_tab(session_id: &str, tab_id: &str) -> Result<(SessionEntry, TabEntry)> {
    let session = index::get(session_id)?;
    let tab = session
        .tab(tab_id)
        .cloned()
        .ok_or_else(|| anyhow!("tab does not belong to this session"))?;
    Ok((session, tab))
}

fn find_tab(tab_id: &str) -> Result<(SessionEntry, TabEntry)> {
    let mut found = index::load()?
        .into_iter()
        .filter_map(|session| session.tab(tab_id).cloned().map(|tab| (session, tab)));
    let result = found.next().ok_or_else(|| anyhow!("tab not found"))?;
    if found.next().is_some() {
        bail!("tab id is ambiguous");
    }
    Ok(result)
}

fn collapse_notification_text(text: &str) -> String {
    let mut out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > 160 {
        out = out.chars().take(159).collect::<String>();
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a phone is offered with Bots off, as a new install has it: the
    /// tests below do not depend on this computer's own settings.
    fn capabilities(runtime: &crate::local_runtime::client::Build) -> Value {
        capabilities_for(runtime, false)
    }

    fn phone_account(id: &str, label: &str, missing: bool) -> crate::agent_accounts::Account {
        crate::agent_accounts::Account {
            id: id.into(), agent: "claude", kind: crate::agent_accounts::Kind::Subscription, label: label.into(),
            email: Some("person@example.com".into()), plan: Some("Max".into()), organization: Some("Example Org".into()),
            local: id == "local", is_default: id == "local", missing, added_at: Some("2026-11-15T00:00:00Z".into()),
        }
    }

    /// The methods `dispatch` answers, read from its own match: each arm's
    /// names, and whether its handler asks `require_driver` before anything
    /// else. Read from the source, so a handler added without a place on the
    /// gate's lists is caught here, not by a phone (PRO-510).
    fn dispatched_methods() -> Vec<(String, bool)> {
        let source = include_str!("rpc.rs");
        let start = source.find("pub(crate) fn dispatch(").expect("dispatch is defined here");
        let end = start + source[start..].find("        _ => return None,").expect("dispatch ends with its fallback");
        let mut arms: Vec<(Vec<String>, String)> = Vec::new();
        for line in source[start..end].lines() {
            let names = line.trim().split_once("=>").and_then(|(pattern, _)| {
                let names: Vec<String> = pattern.split('|').map(str::trim)
                    .map(|name| name.strip_prefix('"').and_then(|name| name.strip_suffix('"')).map(str::to_owned))
                    .collect::<Option<_>>()?;
                (!names.is_empty() && names.iter().all(|name| !name.is_empty())).then_some(names)
            });
            match (names, arms.last_mut()) {
                (Some(names), _) => arms.push((names, line.to_owned())),
                (None, Some((_, body))) => { body.push('\n'); body.push_str(line); }
                (None, None) => {}
            }
        }
        arms.into_iter()
            .flat_map(|(names, body)| {
                let driver = body.contains("require_driver(device).and_then");
                names.into_iter().map(move |name| (name, driver))
            })
            .collect()
    }

    /// Every method the phone dispatch answers is reachable through the gate
    /// both transports run first (`allowed_method`): a driver reaches each one,
    /// a viewer reaches each read and none whose handler asks for a driver,
    /// and a name no handler answers is refused to both (PRO-510).
    #[test]
    fn every_method_the_dispatch_answers_is_admitted_as_its_handler_asks() {
        use super::super::allowed_method;
        let methods = dispatched_methods();
        let names: HashSet<&str> = methods.iter().map(|(name, _)| name.as_str()).collect();
        // The reading above found the dispatch, not an empty or partial one.
        for known in ["sync.capabilities", "session.send", "bots.list", "bots.pauseAll", "cloud.pin", "notifications.subscribe"] {
            assert!(names.contains(known), "{known} not read from dispatch: {names:?}");
        }
        assert_eq!(names.len(), methods.len(), "a method is answered by two arms");
        assert!(methods.iter().any(|(_, driver)| *driver) && methods.iter().any(|(_, driver)| !*driver));
        // Admitted only to a driver by the gate, though its handler does not ask:
        // a lease is released by the driver that took it (`steerLease.acquire`).
        let driver_by_gate = ["steerLease.release"];
        for (method, driver) in &methods {
            assert!(allowed_method(DeviceScope::Driver, method), "{method} is answered but refused to a driver before its handler");
            if *driver {
                assert!(!allowed_method(DeviceScope::Viewer, method), "{method} asks for a driver but a viewer reaches it");
            } else if !driver_by_gate.contains(&method.as_str()) {
                assert!(allowed_method(DeviceScope::Viewer, method), "{method} is a read but refused to a viewer before its handler");
            }
        }
        for name in driver_by_gate {
            assert!(names.contains(name) && !allowed_method(DeviceScope::Viewer, name), "{name}");
        }
        // Names no handler answers: the window's own bot and pin operations
        // a phone was never given, and methods that never existed.
        for unknown in ["bots.delete", "bots.update", "cloud.unpin", "sessions.unpin", "files.read", "bots", ""] {
            assert!(!names.contains(unknown), "{unknown}");
            for scope in [DeviceScope::Viewer, DeviceScope::Driver] {
                assert!(!allowed_method(scope, unknown), "{unknown} is admitted with no handler");
            }
        }
    }

    #[test]
    fn a_phone_is_offered_accounts_only_with_more_than_one_and_never_a_token_or_address() {
        let repo = store::projects::public_id("/repos/raccoon");
        let offered: HashSet<String> = [repo.clone()].into();
        let one = crate::agent_accounts::AgentAccounts { agent: "claude", accounts: vec![phone_account("local", "This Mac's login", false)],
            default_account: "local".into(), project_defaults: Default::default(), auto_switch: Default::default() };
        assert_eq!(phone_accounts(&one, &offered), None, "with one account the reply is as before accounts");

        let several = crate::agent_accounts::AgentAccounts {
            agent: "claude",
            accounts: vec![
                phone_account("local", "This Mac's login", false),
                phone_account("0123456789abcdef", "Work · Max", false),
                phone_account("fedcba9876543210", "Gone", true),
            ],
            default_account: "local".into(),
            project_defaults: [
                ("/repos/raccoon".to_string(), "0123456789abcdef".to_string()),
                ("/repos/archived".to_string(), "0123456789abcdef".to_string()),
            ].into(),
            auto_switch: Default::default(),
        };
        let reply = phone_accounts(&several, &offered).unwrap();
        assert_eq!(reply["defaultAccount"], "local");
        assert_eq!(reply["accounts"], json!([
            {"id": "local", "label": "This Mac's login", "agent": "claude"},
            {"id": "0123456789abcdef", "label": "Work · Max", "agent": "claude"},
        ]));
        // Keyed by the public id a phone knows, never a path, and only for projects it is offered.
        assert_eq!(reply["projectDefaults"], json!({ repo: "0123456789abcdef" }));
        let text = reply.to_string();
        for secret in ["token", "Token", "key", "person@example.com", "Example Org", "/repos/", "plan", "email"] {
            assert!(!text.contains(secret), "{secret} reached the phone: {text}");
        }
        for account in reply["accounts"].as_array().unwrap() {
            let mut keys: Vec<&str> = account.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["agent", "id", "label"]);
        }
    }

    /// #730 and #980: accounts are listed only through a runtime that starts the session on the one chosen.
    #[test]
    fn a_phone_is_listed_accounts_only_through_a_runtime_that_starts_on_them() {
        assert!(!serves_accounts(&runtime_of(Some("0.2.22"), None)), "a released runtime starts every session on the defaults");
        assert!(!serves_accounts(&runtime_of(Some("9.0.0"), Some(json!({ "sessionCreate": 1 })))));
        assert!(!serves_accounts(&runtime_of(Some("9.0.0"), Some(json!({ "sessionAccounts": "1" })))));
        assert!(serves_accounts(&runtime_of(Some("9.0.0"), Some(json!({ "sessionCreate": 1, "sessionAccounts": 1 })))));
    }
    use crate::events::TurnStatus;

    #[test]
    fn manual_status_changes_notify_the_phone_and_change_its_summary() {
        let _home = store::temp_home();
        let session: SessionEntry = serde_json::from_value(json!({
            "id":"manual", "projectPath":"/repo", "cwd":"/repo", "title":"Review", "created":"2026-01-01", "modified":"2026-01-01"
        })).unwrap();
        index::save(&[session]).unwrap();
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(16));
        let runtime = Arc::new(MobileRuntime::new());
        runtime.configure(sink.clone()).unwrap();
        let (tx, _rx) = mpsc::channel(8);
        let invalidations = Arc::new(crate::phone::Invalidations::default());
        runtime.register_client("phone", tx, Arc::new(std::sync::atomic::AtomicBool::new(false)), ConnectionFilter::default(), invalidations.clone());
        let before = summaries_with_row_statuses(Value::Null).unwrap();
        assert!(before["sessions"][0]["manualStatus"].is_null());
        let patch = crate::session_ops::SessionPatch { manual_status: Some(index::ManualStatus::InReview), ..Default::default() };
        let updated = crate::session_ops::update_session_meta("manual", &patch).unwrap();
        sink.emit("session_updated", &updated);
        assert_eq!(invalidations.take(), [json!({"method":"sessions.changed"})]);
        let after = summaries_with_row_statuses(Value::Null).unwrap();
        assert_eq!(after["sessions"][0]["manualStatus"], "in_review");
        // Conditional summary reads must also see the metadata change.
        assert_ne!(conditional(before, None).unwrap()["version"], conditional(after, None).unwrap()["version"]);
    }

    /// #1403: each row says whether the Mac pinned it, and where the Pinned
    /// group places it while the sidebar is in its custom order; a change
    /// of either tells the phone to read the list again.
    #[test]
    fn the_phone_summary_carries_pins_and_the_macs_pinned_order() {
        let _home = store::temp_home();
        let session = |id: &str, pinned: bool, created: &str| -> SessionEntry {
            serde_json::from_value(json!({
                "id": id, "projectPath": "/repo", "cwd": "/repo", "title": id, "created": created, "modified": created, "pinned": pinned,
            })).unwrap()
        };
        index::save(&[session("older", true, "2026-01-01T00:00:00Z"), session("loose", false, "2026-01-02T00:00:00Z"), session("newer", true, "2026-01-03T00:00:00Z")]).unwrap();
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(16));
        let runtime = Arc::new(MobileRuntime::new());
        runtime.configure(sink.clone()).unwrap();
        let (tx, _rx) = mpsc::channel(8);
        let invalidations = Arc::new(crate::phone::Invalidations::default());
        runtime.register_client("phone", tx, Arc::new(std::sync::atomic::AtomicBool::new(false)), ConnectionFilter::default(), invalidations.clone());
        let rows = || {
            let summaries = summaries_with_row_statuses(Value::Null).unwrap();
            summaries["sessions"].as_array().unwrap().iter()
                .map(|row| (row["id"].as_str().unwrap().to_string(), (row["pinned"].clone(), row["pinnedRank"].clone())))
                .collect::<HashMap<_, _>>()
        };
        // By latest activity: pinned, with no place of their own.
        let plain = rows();
        assert_eq!(plain["older"], (json!(true), Value::Null));
        assert_eq!(plain["newer"], (json!(true), Value::Null));
        assert_eq!(plain["loose"], (json!(false), Value::Null));

        // Custom order, as the sidebar first seeds it: pinned first, newest first.
        let order = index::set_sidebar_order(index::SidebarOrderPatch { custom: Some(true), ..Default::default() }).unwrap();
        sink.emit("sidebar_order_changed", &order);
        assert_eq!(invalidations.take(), [json!({"method":"sessions.changed"})]);
        let seeded = rows();
        assert_eq!((&seeded["newer"].1, &seeded["older"].1, &seeded["loose"].1), (&json!(0), &json!(1), &Value::Null));
        // Dragged on the Mac: the phone's Pinned section follows.
        index::set_sidebar_order(index::SidebarOrderPatch { sessions: Some(vec!["older".into(), "newer".into()]), ..Default::default() }).unwrap();
        let dragged = rows();
        assert_eq!((&dragged["older"].1, &dragged["newer"].1), (&json!(0), &json!(1)));

        // Unpinned on the Mac: it leaves the Pinned group, and the phone is told.
        let patch = crate::session_ops::SessionPatch { pinned: Some(false), ..Default::default() };
        let updated = crate::session_ops::update_session_meta("older", &patch).unwrap();
        sink.emit("session_updated", &updated);
        assert_eq!(invalidations.take(), [json!({"method":"sessions.changed"})]);
        let unpinned = rows();
        assert_eq!(unpinned["older"], (json!(false), Value::Null));
        assert_eq!(unpinned["newer"].1, json!(0));

        // Cloud pins are read by `cloud.pins`, and their change is told the same way.
        let pins = store::cloud_pins::set("org-1", "github.com/acme/web", true).unwrap();
        sink.emit(store::cloud_pins::CHANGED, &pins);
        assert_eq!(invalidations.take(), [json!({"method":"sessions.changed"})]);
        assert_eq!(cloud_pins_reply().unwrap(), json!({"orgs": {"org-1": ["github.com/acme/web"]}}));
    }

    #[test]
    fn the_phone_summary_names_a_tab_by_its_generated_title_beside_its_own() {
        let _home = store::temp_home();
        let session = |id: &str, title: &str| -> SessionEntry {
            serde_json::from_value(json!({
                "id": id, "projectPath": "/p", "cwd": "/p", "title": title, "created": "x", "modified": id,
                "tabs": [{ "id": format!("{id}-tab"), "harness": "claude", "created": "x", "title": "You are a worker in a run led" }],
            }))
            .unwrap()
        };
        let made = session("a", "Tabs show the generated title");
        let mut named = session("b", "Tabs show the generated title");
        named.tabs[0].follow.title_pinned = true;
        named.tabs[0].title = Some("Mine".into());
        let untitled = session("c", "New session");
        index::save(&[made, named, untitled]).unwrap();

        let summaries = summaries_with_row_statuses(Value::Null).unwrap();
        let tab = |id: &str| {
            summaries["sessions"].as_array().unwrap().iter().find(|session| session["id"] == id).unwrap()["tabs"][0].clone()
        };
        // The tab's own title still goes, for older phones; the made one beside it.
        assert_eq!(tab("a")["title"], "You are a worker in a run led");
        assert_eq!(tab("a")["generatedTitle"], "Tabs show the generated title");
        // A tab the reader named keeps its name, and one with nothing made yet has none.
        assert_eq!(tab("b")["title"], "Mine");
        assert!(tab("b")["generatedTitle"].is_null());
        assert!(tab("c")["generatedTitle"].is_null());
    }

    #[test]
    fn summaries_date_each_tab_by_its_own_last_activity() {
        let _home = store::temp_home();
        let session: SessionEntry = serde_json::from_value(json!({
            "id": "s", "projectPath": "/p", "cwd": "/p", "title": "t", "created": "2026-01-01T00:00:00Z", "modified": "2026-01-03T00:00:00Z",
            "tabs": [
                { "id": "a", "harness": "claude", "created": "2026-01-01T00:00:00Z", "modified": "2026-01-02T08:00:00Z" },
                { "id": "b", "harness": "codex", "created": "2026-01-01T00:00:00Z", "modified": "2026-01-03T09:30:00Z" },
            ],
        }))
        .unwrap();
        index::save(&[session]).unwrap();
        let tabs = summaries_with_row_statuses(Value::Null).unwrap()["sessions"][0]["tabs"].clone();
        assert_eq!(tabs[0]["modified"], "2026-01-02T08:00:00Z");
        assert_eq!(tabs[1]["modified"], "2026-01-03T09:30:00Z");
    }

    #[test]
    fn a_prompt_image_is_read_only_from_its_session_attachments() {
        let _home = store::temp_home();
        let session: SessionEntry = serde_json::from_value(json!({
            "id": "s", "projectPath": "/p", "cwd": "/p", "title": "t", "created": "x", "modified": "y",
            "tabs": [{ "id": "t", "harness": "claude", "created": "x" }],
        }))
        .unwrap();
        index::save(&[session]).unwrap();
        let attachments = store::attachments_dir("s").unwrap();
        std::fs::write(attachments.join("shot.png"), b"png-bytes").unwrap();
        let read = |session: &str, path: &Path| prompt_image(&PromptImageParams { session_id: session.into(), tab_id: "t".into(), path: path.to_string_lossy().into_owned() });

        let image = read("s", &attachments.join("shot.png")).unwrap();
        assert_eq!(image["mediaType"], "image/png");
        assert_eq!(general_purpose::STANDARD.decode(image["data"].as_str().unwrap()).unwrap(), b"png-bytes");
        // Outside the session's attachments, by path or by a way out of the folder: refused.
        let elsewhere = store::root().unwrap().join("secret.png");
        std::fs::write(&elsewhere, b"secret").unwrap();
        assert!(read("s", &elsewhere).is_err());
        assert!(read("s", &attachments.join("../../secret.png")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&elsewhere, attachments.join("link.png")).unwrap();
            assert!(read("s", &attachments.join("link.png")).is_err(), "a link out of the folder is refused");
        }
        // Not an image, an unknown session, a missing file: refused.
        std::fs::write(attachments.join("notes.txt"), b"text").unwrap();
        assert!(read("s", &attachments.join("notes.txt")).is_err());
        assert!(read("../s", &attachments.join("shot.png")).is_err());
        assert!(read("s", &attachments.join("gone.png")).is_err());
        // A phone may read one, not only a driver.
        assert!(super::super::allowed_method(DeviceScope::Viewer, "session.image"));
    }

    #[test]
    fn a_row_is_named_by_its_branch_as_the_project_list_names_it() {
        let session = |branch: Option<&str>| -> SessionEntry {
            serde_json::from_value(json!({
                "id": "s", "projectPath": "/p", "cwd": "/p", "title": "Fix the login", "created": "x", "modified": "y", "tabs": [],
                "branch": branch,
            }))
            .unwrap()
        };
        let labels: std::collections::BTreeMap<String, String> = [("dc/calm-ember-panda".to_string(), "Login fix".to_string())].into();
        assert_eq!(row_branch(&session(Some("dc/design-tweaks")), None).as_deref(), Some("dc/design-tweaks"));
        // A drawn worktree name is no name: the row takes the conversation's title.
        assert_eq!(row_branch(&session(Some("dc/calm-ember-panda")), None), None);
        assert_eq!(row_branch(&session(Some("calm-ember-panda")), None), None);
        // Unless the reader named the branch.
        assert_eq!(row_branch(&session(Some("dc/calm-ember-panda")), Some(&labels)).as_deref(), Some("Login fix"));
        assert_eq!(row_branch(&session(None), None), None);
        assert_eq!(row_branch(&session(Some("")), None), None);
    }

    fn device(provenance: DeviceProvenance, bound_user_id: Option<&str>) -> DeviceEntry {
        DeviceEntry {
            id: "device-1".into(),
            label: "Paresh's phone".into(),
            platform: "ios".into(),
            token: "token-hash".into(),
            scope: DeviceScope::Driver,
            provenance,
            bound_user_id: bound_user_id.map(str::to_owned),
            binding_generation: 0,
            public_key: String::new(),
            created_at: "2026-09-04T00:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
            installation_id: None,
            created_request_id: None,
            fingerprint: None,
            approved_at: None,
            connection: None,
            last_seen_transport: None,
        }
    }

    fn account() -> AccountMirror {
        AccountMirror {
            user_id: "user-1".into(),
            email: "paresh@example.test".into(),
            display_name: "Paresh".into(),
            host_display_name: None,
            binding_generation: 0,
        }
    }

    fn direct() -> ReplyLimits {
        Wire::new(Transport::Direct).reply_limits(TAIL_RESPONSE_BYTES_LIMIT)
    }

    fn relay(fragments: bool) -> ReplyLimits {
        let wire = Wire::new(Transport::Relay);
        if fragments {
            wire.negotiate(Some(super::super::wire::FRAGMENTS_VERSION.into()));
        }
        wire.reply_limits(TAIL_RESPONSE_BYTES_LIMIT)
    }

    fn cursor(page: &Value) -> SyncCursor {
        serde_json::from_value(page["cursor"].clone()).unwrap()
    }

    fn write_log(path: &Path, events: &[AgentEvent]) {
        let text: String = events.iter().map(|event| serde_json::to_string(event).unwrap() + "\n").collect();
        std::fs::write(path, text).unwrap();
    }

    fn append_log(path: &Path, events: &[AgentEvent]) {
        for event in events {
            store::append_line(path, &serde_json::to_string(event).unwrap()).unwrap();
        }
    }

    /// Reads every page from `checkpoint` to the end with the connection's checkpoints, and checks each
    /// page is the one the whole log gives for the same cursor (#1283).
    fn drain_cached(cache: &SyncCache, path: &Path, mut checkpoint: Option<SyncCursor>, limits: ReplyLimits) -> (Vec<u64>, SyncCursor, bool) {
        let mut seqs = Vec::new();
        let mut reset = false;
        loop {
            let expected = sync_page(&store::read_lines::<AgentEvent>(path).unwrap(), checkpoint.as_ref(), "session", "tab", "test", limits).unwrap();
            let page = synced_page((cache, Reader::Phone), path, checkpoint.as_ref(), "session", "tab", "test", limits).unwrap();
            assert_eq!(page, expected, "a cached page is the page the whole log gives");
            reset |= page["reset"] == true;
            seqs.extend(page["events"].as_array().unwrap().iter().map(|event| event["seq"].as_u64().unwrap()));
            checkpoint = Some(cursor(&page));
            if page["hasMore"] == false { return (seqs, checkpoint.unwrap(), reset); }
        }
    }

    /// #1338: a prefetch that a newer one replaced stops inside a whole-log
    /// read, parse or hash, at whichever check comes first after it was
    /// replaced, and keeps no checkpoint of the page it gave up.
    #[test]
    fn a_prefetch_read_stops_at_its_next_check_once_it_is_no_longer_wanted() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        write_log(&path, &(1..=1300).map(prompt).collect::<Vec<_>>());
        let read = |cache: &SyncCache, cursor: Option<&SyncCursor>, wanted: Wanted| synced_page_while(
            (cache, Reader::Prefetch), &path, cursor, "session", "tab", "prefetch", direct(), wanted);

        // How many checks a whole read and hash makes.
        let checks = AtomicUsize::new(0);
        let counting = || { checks.fetch_add(1, Ordering::SeqCst); true };
        let whole = read(&SyncCache::default(), None, Wanted(&counting)).unwrap();
        let total = checks.load(Ordering::SeqCst);
        assert!(total > 1300 / WANTED_EVERY * 2, "the read and the hash both check as they go: {total}");

        // Stopped at each of them in turn: the read ends at that check and keeps nothing.
        for stop_at in 1..=total {
            let checks = AtomicUsize::new(0);
            let wanted = || checks.fetch_add(1, Ordering::SeqCst) + 1 < stop_at;
            let cache = SyncCache::default();
            let error = read(&cache, None, Wanted(&wanted)).expect_err("a read no longer wanted stops");
            assert!(error.is::<Stopped>(), "{error:#}");
            assert_eq!(checks.load(Ordering::SeqCst), stop_at, "nothing more is read once it is not wanted");
            assert!(cache.matching("session", "tab", &cursor(&whole)).is_none(), "a page given up leaves no checkpoint");
        }

        // From a checkpoint the prefetch kept: the appended part stops too.
        let cache = SyncCache::default();
        let page = read(&cache, None, Wanted::ALWAYS).unwrap();
        append_log(&path, &(1301..=2000).map(prompt).collect::<Vec<_>>());
        let never = || false;
        let error = read(&cache, Some(&cursor(&page)), Wanted(&never)).expect_err("a read no longer wanted stops");
        assert!(error.is::<Stopped>(), "{error:#}");
    }

    #[test]
    fn a_verified_cursor_continues_from_the_appended_bytes_and_any_other_change_reads_the_whole_log() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let cache = SyncCache::default();
        write_log(&path, &(1..=100).map(prompt).collect::<Vec<_>>());
        let (seqs, checkpoint, reset) = drain_cached(&cache, &path, None, direct());
        assert!(reset);
        assert_eq!(seqs, (81..=100).collect::<Vec<_>>());

        // Appended: read from where the checkpoint ends, across pages, and the same as a whole read.
        append_log(&path, &(101..=1300).map(prompt).collect::<Vec<_>>());
        let verified = cache.matching("session", "tab", &checkpoint).expect("the connection kept its checkpoint");
        let tail = super::super::sync_cache::read_after(&path, &verified, Wanted::ALWAYS).unwrap().expect("only lines were appended");
        assert_eq!(tail.events.len(), 1200);
        let (seqs, checkpoint, reset) = drain_cached(&cache, &path, Some(checkpoint), direct());
        assert!(!reset);
        assert_eq!(seqs, (101..=1300).collect::<Vec<_>>());

        // A line still being written is left to the whole read, which skips it, until it ends.
        let partial = serde_json::to_string(&prompt(1301)).unwrap();
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(&partial.as_bytes()[..20]).unwrap();
        let verified = cache.matching("session", "tab", &checkpoint).unwrap();
        assert!(super::super::sync_cache::read_after(&path, &verified, Wanted::ALWAYS).unwrap().is_none());
        let (seqs, checkpoint, _) = drain_cached(&cache, &path, Some(checkpoint), direct());
        assert!(seqs.is_empty());
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(format!("{}\n", &partial[20..]).as_bytes()).unwrap();
        let (seqs, checkpoint, _) = drain_cached(&cache, &path, Some(checkpoint), direct());
        assert_eq!(seqs, vec![1301]);

        // Rewritten in place under the checkpoint, at the same length: the fingerprint catches it.
        let mut changed = store::read_lines::<AgentEvent>(&path).unwrap();
        let last = changed.len() - 1;
        changed[last] = event(1301, Payload::UserMessage { author: None, bot: None, text: "prompt 9999".into(), images: Vec::new(), files: Vec::new(), baseline: None, queued: false, cwd: None });
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().write_all(
            changed.iter().map(|event| serde_json::to_string(event).unwrap() + "\n").collect::<String>().as_bytes()).unwrap();
        let (_, checkpoint, reset) = drain_cached(&cache, &path, Some(checkpoint), direct());
        assert!(reset, "a changed record is a reset, as it was before the cache");

        // Replaced by a new file, and truncated: both read whole again.
        let replacement = dir.path().join("replacement.jsonl");
        write_log(&replacement, &(1..=50).map(prompt).collect::<Vec<_>>());
        std::fs::rename(&replacement, &path).unwrap();
        let (_, checkpoint, reset) = drain_cached(&cache, &path, Some(checkpoint), direct());
        assert!(reset);
        std::fs::write(&path, b"").unwrap();
        let (seqs, _, reset) = drain_cached(&cache, &path, Some(checkpoint), direct());
        assert!(reset);
        assert!(seqs.is_empty());
    }

    /// What one `session.sync` catch-up costs the Mac, before and after #1283:
    /// `cargo test --lib phone::rpc::tests::sync_cost -- --ignored --nocapture`.
    /// Before, every page read and hashed the whole log; after, a cursor this
    /// connection returned reads only the lines appended since.
    #[test]
    #[ignore = "a measurement, not a check"]
    fn sync_cost() {
        let dir = tempfile::tempdir().unwrap();
        let tool = |seq: u64| event(seq, Payload::AssistantText { block: None, text: "x".repeat(600) });
        for size in [1_000u64, 10_000, 50_000] {
            let path = dir.path().join(format!("log-{size}.jsonl"));
            write_log(&path, &(1..=size).map(|seq| if seq % 10 == 0 { prompt(seq) } else { tool(seq) }).collect::<Vec<_>>());
            let cache = SyncCache::default();
            let mut checkpoint = cursor(&synced_page((&cache, Reader::Phone), &path, None, "session", "tab", "test", relay(true)).unwrap());
            let rounds = 20;
            let (mut before, mut after) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
            for n in 0..rounds {
                append_log(&path, &[tool(size + 1 + n)]);
                let started = std::time::Instant::now();
                let old = sync_page(&store::read_lines::<AgentEvent>(&path).unwrap(), Some(&checkpoint), "session", "tab", "test", relay(true)).unwrap();
                before += started.elapsed();
                let started = std::time::Instant::now();
                let new = synced_page((&cache, Reader::Phone), &path, Some(&checkpoint), "session", "tab", "test", relay(true)).unwrap();
                after += started.elapsed();
                assert_eq!(old, new);
                checkpoint = cursor(&new);
            }
            let bytes = std::fs::metadata(&path).unwrap().len();
            println!("{size:>6} events ({:>5.1} MB): one-event catch-up page {:>8.2} ms before, {:>6.3} ms after",
                bytes as f64 / 1e6, before.as_secs_f64() * 1e3 / rounds as f64, after.as_secs_f64() * 1e3 / rounds as f64);
        }
    }

    #[test]
    fn a_checkpoint_is_kept_per_conversation_and_only_for_the_cursor_last_returned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let cache = SyncCache::default();
        write_log(&path, &(1..=30).map(prompt).collect::<Vec<_>>());
        let first = cursor(&synced_page((&cache, Reader::Phone), &path, None, "session", "tab", "test", direct()).unwrap());
        assert!(cache.matching("session", "tab", &first).is_some());
        assert!(cache.matching("session", "other", &first).is_none());
        append_log(&path, &[prompt(31)]);
        let second = cursor(&synced_page((&cache, Reader::Phone), &path, Some(&first), "session", "tab", "test", direct()).unwrap());
        assert!(cache.matching("session", "tab", &first).is_none());
        // An older cursor is still answered, from the whole log.
        let again = synced_page((&cache, Reader::Phone), &path, Some(&first), "session", "tab", "test", direct()).unwrap();
        assert_eq!(cursor(&again), second);
        assert_eq!(again["events"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_page_that_says_there_is_more_is_continued_without_another_reconcile_and_a_prefetch_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let cache = SyncCache::default();
        write_log(&path, &(1..=20).map(prompt).collect::<Vec<_>>());
        let start = cursor(&synced_page((&cache, Reader::Phone), &path, None, "session", "tab", "test", direct()).unwrap());
        assert!(!cache.continuing("session", "tab", &start), "the last page of a read is not continued");
        append_log(&path, &(21..=1200).map(prompt).collect::<Vec<_>>());
        let page = synced_page((&cache, Reader::Phone), &path, Some(&start), "session", "tab", "test", direct()).unwrap();
        assert_eq!(page["hasMore"], true);
        assert!(cache.continuing("session", "tab", &cursor(&page)));
        // A prefetch page that says there is more is no read under way: the phone's next read reconciles.
        let saved = cursor(&sync_page(&(1..=10).map(prompt).collect::<Vec<_>>(), None, "session", "tab", "test", direct()).unwrap());
        let prefetched = synced_page((&cache, Reader::Prefetch), &path, Some(&saved), "session", "tab", "prefetch", direct()).unwrap();
        assert_eq!(prefetched["hasMore"], true);
        assert_ne!(cursor(&prefetched), cursor(&page));
        assert!(!cache.continuing("session", "tab", &cursor(&prefetched)));
        assert!(cache.continuing("session", "tab", &cursor(&page)), "and the phone's own read stays under way");
    }

    /// #1381: a phone that names its open conversations, even as none, is
    /// taken at its word: one it read a moment ago and has since closed is
    /// sent its new events. One that names none is judged as before.
    #[test]
    fn a_named_open_list_replaces_the_recently_read_guess() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let cache = SyncCache::default();
        write_log(&path, &(1..=20).map(prompt).collect::<Vec<_>>());
        // The phone read the conversation a moment ago, then closed it; new events follow.
        drain_cached(&cache, &path, None, direct());
        append_log(&path, &(21..=25).map(prompt).collect::<Vec<_>>());
        let open = |params: Value| -> Option<HashSet<(String, String)>> {
            let params: PrefetchParams = serde_json::from_value(params).unwrap();
            params.open.map(|open| open.into_iter().map(|open| (open.session_id, open.tab_id)).collect())
        };
        let none = open(json!({ "enabled": true, "open": [] }));
        assert_eq!(none, Some(HashSet::new()), "an empty list is a list");
        assert!(!reading_for_itself(&cache, none.as_ref(), "session", "tab"), "a just-closed conversation is prefetched");
        let other = open(json!({ "enabled": true, "open": [{ "sessionId": "session", "tabId": "other" }] }));
        assert!(!reading_for_itself(&cache, other.as_ref(), "session", "tab"));
        assert!(reading_for_itself(&cache, other.as_ref(), "session", "other"), "one named open is left");
        let legacy = open(json!({ "enabled": true }));
        assert_eq!(legacy, None);
        assert!(reading_for_itself(&cache, legacy.as_ref(), "session", "tab"), "a phone that names none keeps the recent-read guess");
    }

    /// #1337: a prefetch for a conversation open on the phone, whose page the
    /// phone drops, leaves the phone reader's checkpoint as it was, so its
    /// next `session.sync` still reads only what was appended; and a prefetch
    /// sends nothing for a conversation the phone reads for itself.
    #[test]
    fn a_prefetch_while_a_transcript_is_open_keeps_its_next_sync_incremental_and_sends_it_nothing() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let cache = SyncCache::default();
        let events: Vec<_> = (1..=300).map(prompt).collect();
        write_log(&path, &events);
        // What the phone saved of this conversation earlier: up to record 200.
        let saved = cursor(&sync_page(&events[..200], None, "session", "tab", "test", direct()).unwrap());
        assert!(!reading_for_itself(&cache, None, "session", "tab"));

        // The transcript opens and reads for itself.
        let (_, open, _) = drain_cached(&cache, &path, None, direct());
        assert!(reading_for_itself(&cache, None, "session", "tab"), "a conversation read a moment ago is open");
        assert!(!reading_for_itself(&cache, None, "session", "other"));
        let named: HashSet<_> = [("session".to_string(), "other".to_string())].into();
        assert!(reading_for_itself(&cache, Some(&named), "session", "other"), "one the phone names open is too");

        // Records are appended; a prefetch from the saved checkpoint runs, and the open screen drops its page.
        append_log(&path, &(301..=310).map(prompt).collect::<Vec<_>>());
        let prefetched = synced_page((&cache, Reader::Prefetch), &path, Some(&saved), "session", "tab", "prefetch", direct()).unwrap();
        assert_eq!(prefetched["reset"], false);
        assert_eq!(prefetched["events"][0]["seq"], 201, "a page from the saved checkpoint");
        assert!(cache.matching("session", "tab", &open).is_some(), "the open reader's checkpoint survives the prefetch");
        assert!(cache.matching("session", "tab", &cursor(&prefetched)).is_some(), "and a phone that keeps the page continues from it");

        // Rewrite the first record in place, at the same length and outside the
        // fingerprint: a whole-log read would see the change and reset, so a
        // page that does not reset was read from the appended bytes alone.
        let bytes = std::fs::read(&path).unwrap();
        let at = bytes.windows(10).position(|window| window == b"\"prompt 1\"").unwrap();
        let mut changed = bytes.clone();
        changed[at + 8] = b'7';
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().write_all(&changed).unwrap();
        let next = synced_page((&cache, Reader::Phone), &path, Some(&open), "session", "tab", "test", direct()).unwrap();
        assert_eq!(next["reset"], false, "the open reader's next sync stays incremental");
        let seqs: Vec<_> = next["events"].as_array().unwrap().iter().map(|event| event["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, (301..=310).collect::<Vec<_>>());
    }

    #[test]
    fn a_prefetch_goes_newest_session_first_and_its_newest_tabs_and_skips_archived_ones() {
        let session = |id: &str, modified: &str, tabs: &[(&str, &str)], archived: bool| -> SessionEntry {
            serde_json::from_value(json!({
                "id": id, "projectPath": "/p", "cwd": "/p", "title": id, "created": "x", "modified": modified, "archived": archived,
                "tabs": tabs.iter().map(|(tab, modified)| json!({ "id": tab, "harness": "claude", "created": "x", "modified": modified })).collect::<Vec<_>>(),
            })).unwrap()
        };
        let mut sessions = vec![
            session("old", "2026-11-01", &[("old-1", "2026-11-01")], false),
            session("busy", "2026-11-02", &[("b-1", "2026-11-03"), ("b-2", "2026-11-19"), ("b-3", "2026-11-05"), ("b-4", "2026-11-04")], false),
            session("archived", "2026-11-18", &[("a-1", "2026-11-18")], true),
            session("recent", "2026-11-10", &[("r-1", "2026-11-10")], false),
        ];
        sessions.extend((0..10).map(|n| session(&format!("filler-{n}"), "2026-10-01", &[("f", "2026-10-01")], false)));
        let targets = prefetch_targets(sessions);
        let ids: Vec<_> = targets.iter().map(|(session, tab)| format!("{session}/{tab}")).collect();
        assert_eq!(&ids[..5], ["busy/b-2", "busy/b-3", "busy/b-4", "recent/r-1", "old/old-1"]);
        assert!(!ids.iter().any(|id| id.starts_with("archived/")));
        assert_eq!(targets.iter().map(|(session, _)| session).collect::<HashSet<_>>().len(), PREFETCH_SESSIONS);
    }

    /// #1339: the phone asks what a prefetch would send before naming its
    /// checkpoints, and is told the very conversations the prefetch sends.
    #[test]
    fn a_phone_is_told_the_conversations_a_prefetch_would_send() {
        let _home = store::temp_home();
        let session = |id: &str, modified: &str, tabs: &[&str], archived: bool| -> SessionEntry {
            serde_json::from_value(json!({
                "id": id, "projectPath": "/p", "cwd": "/p", "title": id, "created": "x", "modified": modified, "archived": archived,
                "tabs": tabs.iter().map(|tab| json!({ "id": tab, "harness": "claude", "created": "x", "modified": modified })).collect::<Vec<_>>(),
            })).unwrap()
        };
        let sessions = vec![
            session("older", "2026-11-01", &["o-1"], false),
            session("newer", "2026-11-02", &["n-1"], false),
            session("archived", "2026-11-03", &["a-1"], true),
        ];
        index::save(&sessions).unwrap();
        let reply = prefetch_targets_reply().unwrap();
        assert_eq!(reply, json!({ "targets": [
            { "sessionId": "newer", "tabId": "n-1" },
            { "sessionId": "older", "tabId": "o-1" },
        ] }));
        let sent: Vec<_> = prefetch_targets(index::load().unwrap()).into_iter()
            .map(|(session, tab)| json!({ "sessionId": session, "tabId": tab })).collect();
        assert_eq!(reply["targets"], json!(sent));
    }

    #[test]
    fn sync_cold_unchanged_and_large_gap_are_contiguous() {
        let mut events: Vec<_> = (1..=100).map(prompt).collect();
        let cold = sync_page(&events, None, "session", "tab", "test", direct()).unwrap();
        assert_eq!(cold["events"].as_array().unwrap().len(), 20);
        assert_eq!(cold["reset"], true);
        let mut checkpoint = cursor(&cold);
        let warm = sync_page(&events, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        assert_eq!(warm["events"], json!([]));
        assert_eq!(warm["reset"], false);
        events.extend((101..=6200).map(prompt));
        let mut received = Vec::new();
        loop {
            let page = sync_page(&events, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
            assert_eq!(page["reset"], false);
            received.extend(page["events"].as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()));
            checkpoint = cursor(&page);
            if page["hasMore"] == false { break; }
        }
        assert_eq!(received, (101..=6200).collect::<Vec<_>>());
    }

    #[test]
    fn sync_rewrites_truncations_and_wrong_generation_reset_boundedly() {
        let mut events: Vec<_> = (1..=600).map(prompt).collect();
        let checkpoint = cursor(&sync_page(&events, None, "session", "tab", "test", direct()).unwrap());
        // Same seq/id and length, different content: max-seq cursors miss this.
        events[599].ts = "changed".into();
        for (history, session) in [(&events[..], "session"), (&events[..10], "session"), (&events[..], "other")] {
            let reset = sync_page(history, Some(&checkpoint), session, "tab", "test", direct()).unwrap();
            assert_eq!(reset["reset"], true);
            assert!(reset["events"].as_array().unwrap().len() <= SYNC_PAGE_EVENTS);
        }
        let empty = sync_page(&[], Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        assert_eq!(empty["events"], json!([]));
        assert_eq!(empty["reset"], true);
    }

    #[test]
    fn sync_pages_bound_the_rpc_response_without_skipping_forward_records() {
        let events: Vec<_> = std::iter::once(prompt(1))
            .chain((2..=17).map(|seq| output(seq, "🦝\n\"".repeat(128 * 1024))))
            .collect();
        let request_id = "\"\n🦝".repeat(20);
        let cold = sync_page(&events, None, "session", "tab", &request_id, direct()).unwrap();
        assert_eq!(cold["reset"], true);
        assert_eq!(cold["hasEarlier"], true);
        assert_eq!(cold["events"].as_array().unwrap().last().unwrap()["seq"], 17);
        assert!(success_response(&request_id, cold).to_string().len() <= TAIL_RESPONSE_BYTES_LIMIT);

        let mut checkpoint = cursor(&sync_page(&[], None, "session", "tab", &request_id, direct()).unwrap());
        let mut received = Vec::new();
        let mut pages = 0;
        loop {
            let page = sync_page(&events, Some(&checkpoint), "session", "tab", &request_id, direct()).unwrap();
            assert_eq!(page["reset"], false);
            assert!(success_response(&request_id, page.clone()).to_string().len() <= TAIL_RESPONSE_BYTES_LIMIT);
            let rows = page["events"].as_array().unwrap();
            assert!(!rows.is_empty());
            let next = cursor(&page);
            assert_eq!(next.offset, checkpoint.offset + rows.len());
            received.extend(rows.iter().map(|event| event["seq"].as_u64().unwrap()));
            checkpoint = next;
            pages += 1;
            if page["hasMore"] == false { break; }
        }
        assert!(pages > 1);
        assert_eq!(received, (1..=17).collect::<Vec<_>>());
    }

    #[test]
    fn sync_sends_an_oversized_event_alone_cut_down_and_advances_past_it() {
        let initial = cursor(&sync_page(&[], None, "session", "tab", "test", direct()).unwrap());
        let events = vec![prompt(1), output(2, "x".repeat(TAIL_RESPONSE_BYTES_LIMIT)), prompt(3)];
        let first = sync_page(&events, Some(&initial), "session", "tab", "test", direct()).unwrap();
        assert_eq!(first["events"].as_array().unwrap().len(), 1);
        assert_eq!(first["hasMore"], true);
        let checkpoint = cursor(&first);
        assert_eq!(checkpoint.offset, 1);
        let second = sync_page(&events, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        assert!(success_response("test", second.clone()).to_string().len() <= TAIL_RESPONSE_BYTES_LIMIT);
        let rows = second["events"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["seq"], 2);
        assert_eq!(rows[0]["payload"]["callId"], "call-2");
        let text = rows[0]["payload"]["result"]["text"].as_str().unwrap();
        assert!(text.starts_with("xxxx"));
        assert!(text.ends_with(&crate::platform_profile::localize("not shown. Open this conversation on your Mac to see all of it.]")), "{text}");
        // The cursor covers the whole event: the next page starts after it.
        let third = sync_page(&events, Some(&cursor(&second)), "session", "tab", "test", direct()).unwrap();
        assert_eq!(third["events"][0]["seq"], 3);
        assert_eq!(third["hasMore"], false);
        let reset = sync_page(&events[..2], None, "session", "tab", "test", direct()).unwrap();
        assert_eq!(reset["events"][0]["seq"], 2);
        assert_eq!(reset["hasEarlier"], true);
    }

    /// The conversation from #669: 500 recent events, about 0.8 MiB of JSON,
    /// on a phone with nothing cached. On Relay every reply must fit one
    /// 1 MiB cell message, and the history still loads in full.
    #[test]
    fn a_long_conversation_loads_over_relay_one_frame_at_a_time() {
        let events: Vec<_> = (1..=600).map(|seq| {
            if seq % 25 == 1 { prompt(seq) } else { output(seq, "🦝 tool output \"line\"\n".repeat(80)) }
        }).collect();
        assert!(serde_json::to_vec(&events[100..]).unwrap().len() > 1024 * 1024);
        let request_id = "mobile-1761756316000-42";
        for limits in [relay(false), relay(true)] {
            assert!(limits.page < 1024 * 1024 / 4 * 3);
            let cold = sync_page(&events, None, "session", "tab", request_id, limits).unwrap();
            assert!(success_response(request_id, cold.clone()).to_string().len() <= limits.page);
            assert_eq!(cold["reset"], true);
            assert_eq!(cold["hasEarlier"], true);
            assert_eq!(cold["events"].as_array().unwrap().last().unwrap()["seq"], 600);
            // Load earlier pages back to the first event, each one frame.
            let mut seen: Vec<u64> = cold["events"].as_array().unwrap().iter().map(|event| event["seq"].as_u64().unwrap()).collect();
            let byte_limit = tail_event_byte_limit(request_id, limits.page).unwrap();
            let mut before = Some(seen[0]);
            let source = tail_log(&events);
            loop {
                let (page, more) = read_event_tail(source.path(), before, 20, byte_limit).unwrap();
                let response = success_response(request_id, json!({ "events": page, "hasMore": more })).to_string();
                assert!(response.len() <= limits.page);
                before = Some(page[0].seq);
                seen.splice(0..0, page.iter().map(|event| event.seq));
                if !more { break; }
            }
            assert_eq!(seen, (1..=600).collect::<Vec<_>>());
        }
    }

    #[test]
    fn over_relay_an_event_larger_than_a_page_is_whole_only_when_it_can_be_fragmented() {
        let large = output(2, "y".repeat(2 * 1024 * 1024));
        let events = vec![prompt(1), large.clone()];
        let legacy = sync_page(&events, None, "session", "tab", "test", relay(false)).unwrap();
        assert!(success_response("test", legacy.clone()).to_string().len() <= relay(false).page);
        assert_eq!(legacy["events"].as_array().unwrap().len(), 1);
        assert!(legacy["events"][0]["payload"]["result"]["text"].as_str().unwrap().contains("Too large to show on mobile"));
        let fragmented = sync_page(&events, None, "session", "tab", "test", relay(true)).unwrap();
        assert_eq!(fragmented["events"].as_array().unwrap().len(), 1);
        assert_eq!(fragmented["events"][0], serde_json::to_value(&large).unwrap());
        assert_eq!(fragmented["hasEarlier"], true);
    }

    #[test]
    fn fit_event_cuts_the_longest_strings_on_character_boundaries() {
        let large = event(7, Payload::ToolCallStarted {
            call_id: "call-7".into(),
            name: "Write".into(),
            tool_type: crate::events::ToolType::Other,
            input: json!({ "path": "notes.md", "content": "🦝\"\\\n\u{1}".repeat(40_000), "old": "z".repeat(30_000) }),
            title: Some("Write notes.md".into()),
        });
        let whole = serde_json::to_vec(&large).unwrap().len();
        for budget in [whole, whole - 1, whole / 2, 40_000, 2_000] {
            let fitted = fit_event(&large, budget).unwrap();
            let size = serde_json::to_vec(&fitted).unwrap().len();
            assert!(size <= budget, "{size} > {budget}");
            assert_eq!(fitted["seq"], 7);
            assert_eq!(fitted["id"], "event-7");
            assert_eq!(fitted["payload"]["type"], "tool_call_started");
            assert_eq!(fitted["payload"]["callId"], "call-7");
            assert_eq!(fitted["payload"]["input"]["path"], "notes.md");
            let content = fitted["payload"]["input"]["content"].as_str().unwrap();
            if budget == whole {
                assert_eq!(fitted, serde_json::to_value(&large).unwrap());
            } else {
                assert!(content.ends_with("to see all of it.]"));
                // What is kept is a prefix of the original, cut between characters.
                let kept = &content[..content.find("\n\n[Too large").unwrap()];
                assert!("🦝\"\\\n\u{1}".repeat(40_000).starts_with(kept));
            }
        }
        // The longest string goes first; a small excess leaves the rest alone.
        let fitted = fit_event(&large, whole - 1).unwrap();
        assert_eq!(fitted["payload"]["input"]["old"], "z".repeat(30_000));
    }

    #[test]
    fn fit_event_falls_back_to_a_status_line_when_no_string_is_large() {
        let many = event(9, Payload::ToolCallCompleted {
            call_id: "call-9".into(),
            result: crate::events::ToolResult {
                structured: Some(json!((0..20_000).collect::<Vec<_>>())),
                ..Default::default()
            },
        });
        let fitted = fit_event(&many, 4_096).unwrap();
        assert!(serde_json::to_vec(&fitted).unwrap().len() <= 4_096);
        assert_eq!(fitted["seq"], 9);
        assert_eq!(fitted["payload"]["type"], "status");
        assert!(fitted["payload"]["text"].as_str().unwrap().starts_with("This item is too large to show on mobile"));
        assert!(serde_json::from_value::<AgentEvent>(fitted).is_ok());
    }

    #[test]
    fn conditional_lists_return_only_versions_when_unchanged() {
        let initial = conditional(json!({"messages": [{"body": "synthetic"}]}), None).unwrap();
        let version = initial["version"].as_str().unwrap().to_string();
        let same = conditional(json!({"messages": [{"body": "synthetic"}]}), Some(version.clone())).unwrap();
        assert_eq!(same, json!({"notModified": true, "version": version}));
        assert!(conditional(json!({"messages": []}), Some(version)).unwrap().get("messages").is_some());
    }

    #[test]
    fn synthetic_sync_payload_measurement() {
        // 2,000 turns, six events per turn, no private content.
        let events: Vec<_> = (1..=12000).map(|seq| {
            if seq % 6 == 1 { prompt(seq) }
            else { event(seq, Payload::AssistantText { text: "x".repeat(512), block: None }) }
        }).collect();
        let cold = sync_page(&events, None, "session", "tab", "test", direct()).unwrap();
        let checkpoint = cursor(&cold);
        let warm = sync_page(&events, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        let mut changed = events.clone();
        changed.push(prompt(12001));
        let delta = sync_page(&changed, Some(&checkpoint), "session", "tab", "test", direct()).unwrap();
        let (tail, more) = select_event_tail(events.into_iter().rev().map(Ok), None, 20, tail_event_byte_limit("test", TAIL_RESPONSE_BYTES_LIMIT).unwrap()).unwrap();
        let legacy = json!({ "events": tail, "hasMore": more });
        let bytes = |v: &Value| serde_json::to_vec(v).unwrap().len();
        let request = |method: &str, params: Value| bytes(&json!({ "method": method, "params": params }));
        let cold_request = request("session.sync", json!({"sessionId": "session", "tabId": "tab"}));
        let warm_request = request("session.sync", json!({"sessionId": "session", "tabId": "tab", "cursor": checkpoint}));
        let tail_request = request("session.tail", json!({"sessionId": "session", "tabId": "tab", "limit": 20}));
        println!("synthetic transcript result bytes (one page each): legacy={}, cold={}, warm={}, delta={}", bytes(&legacy), bytes(&cold), bytes(&warm), bytes(&delta));
        println!("synthetic request bytes (method + params): legacy={tail_request}, cold={cold_request}, warm={warm_request}, delta={warm_request}");
        assert!(bytes(&warm) * 100 < bytes(&legacy));
        assert!(bytes(&delta) * 50 < bytes(&legacy));
    }

    fn event(seq: u64, payload: Payload) -> AgentEvent {
        AgentEvent {
            id: format!("event-{seq}"),
            session_id: "session".into(),
            tab_id: "tab".into(),
            harness: "codex".into(),
            seq,
            ts: "2026-09-03T00:00:00Z".into(),
            message_ts: Some("2026-09-02T23:59:00Z".into()), prompt_request_id: None,
            subagent: None,
            payload,
        }
    }

    fn prompt(seq: u64) -> AgentEvent {
        event(
            seq,
            Payload::UserMessage { author: None, bot: None,
                text: format!("prompt {seq}"),
                images: Vec::new(),
                files: Vec::new(),
                baseline: None,
                queued: false,
                cwd: None,
            },
        )
    }

    #[test]
    fn paged_tail_keeps_whole_turns_in_sequence_order() {
        let events = vec![
            prompt(1),
            event(2, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false, detail: None }),
            prompt(3),
            event(4, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false, detail: None }),
            prompt(5),
            event(6, Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false, detail: None }),
        ];
        let (tail, has_more) = select_event_tail(events.into_iter().rev().map(Ok), None, 2, tail_event_byte_limit("test", TAIL_RESPONSE_BYTES_LIMIT).unwrap()).unwrap();
        assert!(has_more);
        assert_eq!(tail.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
    }

    fn tail_log(events: &[AgentEvent]) -> tempfile::NamedTempFile {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        for event in events {
            serde_json::to_writer(&mut file, event).unwrap();
            writeln!(file).unwrap();
        }
        file
    }

    fn output(seq: u64, text: String) -> AgentEvent {
        event(seq, Payload::ToolCallCompleted { call_id: format!("call-{seq}"), result: crate::events::ToolResult { text, ..Default::default() } })
    }

    #[test]
    fn tail_counts_serialized_utf8_and_json_escapes_at_the_exact_boundary() {
        let events = vec![prompt(1), output(2, "🦝\n\"\\".repeat(100)), output(3, "tail".into())];
        let file = tail_log(&events);
        let budget = serde_json::to_vec(&events[1]).unwrap().len() + 1 + serde_json::to_vec(&events[2]).unwrap().len();
        let (page, more) = read_event_tail(file.path(), None, 20, budget).unwrap();
        assert_eq!(page.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), None, 20, budget - 1).unwrap();
        assert_eq!(page.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![3]);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), Some(2), 20, budget).unwrap();
        assert_eq!(page[0].seq, 1);
        assert!(!more);
        let (page, more) = read_event_tail(file.path(), Some(1), 20, budget).unwrap();
        assert!(page.is_empty());
        assert!(!more);
    }

    #[test]
    fn tail_budget_includes_the_complete_rpc_envelope() {
        let id = "\"\n🦝".repeat(20);
        let budget = tail_event_byte_limit(&id, TAIL_RESPONSE_BYTES_LIMIT).unwrap();
        let overhead = serde_json::to_vec(&output(1, String::new())).unwrap().len();
        let file = tail_log(&[output(1, "x".repeat(budget - overhead))]);
        let (page, more) = read_event_tail(file.path(), None, 20, budget).unwrap();
        assert!(!more);
        assert_eq!(success_response(&id, json!({ "events": page, "hasMore": more })).to_string().len(), TAIL_RESPONSE_BYTES_LIMIT);
        // One byte over: still the whole page, for the caller to cut down.
        let (page, more) = read_event_tail(file.path(), None, 20, budget - 1).unwrap();
        assert_eq!(page.len(), 1);
        assert!(!more);
        let fitted = fit_event(&page[0], budget - 1).unwrap();
        assert!(serde_json::to_vec(&fitted).unwrap().len() < budget);
    }

    #[test]
    fn tail_sends_a_single_oversized_event_alone_without_skipping_it() {
        let events = vec![prompt(1), output(2, "large tool result".repeat(100)), prompt(3)];
        let file = tail_log(&events);
        let (page, more) = read_event_tail(file.path(), None, 20, 1024).unwrap();
        assert_eq!(page.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![3]);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), Some(3), 20, 1024).unwrap();
        assert_eq!(page, vec![events[1].clone()]);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), Some(2), 20, 1024).unwrap();
        assert_eq!(page[0].seq, 1);
        assert!(!more);
        let file = tail_log(&events[..2]);
        let (page, more) = read_event_tail(file.path(), None, 20, 1024).unwrap();
        assert_eq!(page[0].seq, 2);
        assert!(more);
    }

    #[test]
    fn tail_event_limit_can_split_a_single_turn_without_losing_the_prompt() {
        let events: Vec<_> = std::iter::once(prompt(1))
            .chain((2..=TAIL_EVENT_LIMIT as u64 + 1).map(|seq| output(seq, String::new())))
            .collect();
        let file = tail_log(&events);
        let budget = tail_event_byte_limit("test", TAIL_RESPONSE_BYTES_LIMIT).unwrap();
        let (page, more) = read_event_tail(file.path(), None, 20, budget).unwrap();
        assert_eq!(page.len(), TAIL_EVENT_LIMIT);
        assert_eq!(page[0].seq, 2);
        assert!(more);
        let (page, more) = read_event_tail(file.path(), Some(2), 20, budget).unwrap();
        assert_eq!(page[0].seq, 1);
        assert!(!more);
    }

    #[test]
    fn tail_ignores_invalid_lines_and_handles_empty_or_missing_logs() {
        use std::io::Write;
        let mut file = tail_log(&[prompt(1)]);
        writeln!(file, "not an event").unwrap();
        writeln!(file, "{{\"partial\":").unwrap();
        let (page, more) = read_event_tail(file.path(), None, 1, 1024).unwrap();
        assert_eq!(page[0].seq, 1);
        assert!(!more);
        let empty = tempfile::NamedTempFile::new().unwrap();
        let (page, more) = read_event_tail(empty.path(), None, 20, 1024).unwrap();
        assert!(page.is_empty() && !more);
        let missing = empty.path().to_owned();
        drop(empty);
        let (page, more) = read_event_tail(&missing, None, 20, 1024).unwrap();
        assert!(page.is_empty() && !more);
    }

    #[test]
    fn tail_rebounds_events_appended_by_permission_reconciliation() {
        let mut events = vec![prompt(1), output(2, "result".into())];
        let budget = serde_json::to_vec(&events[0]).unwrap().len() + 1 + serde_json::to_vec(&events[1]).unwrap().len();
        events.push(event(3, Payload::PermissionDecided { request_id: "request".into(), tool_use_id: Some("tool".into()), allowed: false, label: "Lapsed".into(), automatic: true }));
        let (page, more) = select_event_tail(events.into_iter().rev().map(Ok), None, usize::MAX, budget).unwrap();
        assert!(more);
        assert_eq!(page.last().unwrap().seq, 3);
        // All returned sequences still form a suffix, so the next cursor cannot
        // jump over an event displaced by the appended decision.
        assert_eq!(page.iter().map(|event| event.seq).collect::<Vec<_>>(), (page[0].seq..=3).collect::<Vec<_>>());
        assert!(serde_json::to_vec(&page).unwrap().len() <= budget + 2);
    }

    #[tokio::test]
    async fn large_history_pages_fit_the_encrypted_websocket_and_preserve_every_cursor() {
        use crate::relay_e2ee::{begin_e2ee_session, E2eeClientHandshake, HostKeypair, PayloadKind};
        use super::super::{pairing_websocket_config, send_encrypted_text};
        use futures_util::StreamExt;
        use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};

        // A single turn, larger than both the plaintext and the 10 MiB wire
        // limits. Turn limits alone cannot bound it.
        let events: Vec<_> = std::iter::once(prompt(1))
            .chain((2..=16).map(|seq| output(seq, "x".repeat(1024 * 1024))))
            .collect();
        let file = tail_log(&events);
        let id = "\"\n🦝".repeat(20);
        let budget = tail_event_byte_limit(&id, TAIL_RESPONSE_BYTES_LIMIT).unwrap();
        let key = HostKeypair::from_secret([7; 32]);
        let handshake = E2eeClientHandshake::new(&key.public_key_b64(), "direct", None).unwrap();
        let (ready, mut host) = begin_e2ee_session(&key, handshake.hello().clone(), "direct", None).unwrap();
        let mut phone = handshake.accept_ready(&serde_json::to_string(&ready).unwrap()).unwrap();
        let (host_io, phone_io) = tokio::io::duplex(64 * 1024);
        let mut host_socket = WebSocketStream::from_raw_socket(host_io, Role::Server, Some(pairing_websocket_config())).await;
        let mut phone_socket = WebSocketStream::from_raw_socket(phone_io, Role::Client, Some(pairing_websocket_config())).await;
        let mut before = None;
        let mut seen = Vec::new();
        let mut pages = 0;
        loop {
            let (page, more) = read_event_tail(file.path(), before, 20, budget).unwrap();
            assert!(!page.is_empty());
            assert!(page.windows(2).all(|pair| pair[0].seq < pair[1].seq));
            assert!(page.iter().all(|event| before.is_none_or(|cursor| event.seq < cursor)));
            before = Some(page[0].seq);
            seen.extend(page.iter().rev().map(|event| event.seq));
            let response = success_response(&id, json!({ "events": page, "hasMore": more })).to_string();
            assert!(response.len() <= TAIL_RESPONSE_BYTES_LIMIT);
            let (sent, received) = tokio::join!(send_encrypted_text(&mut host_socket, &mut host, &response), phone_socket.next());
            sent.unwrap();
            let text = received.unwrap().unwrap().into_text().unwrap();
            assert!(text.len() < super::super::PAIRING_MESSAGE_BYTES_LIMIT);
            let frame = general_purpose::STANDARD.decode(text.as_bytes()).unwrap();
            assert_eq!(phone.open(&frame, PayloadKind::Text).unwrap(), response.as_bytes());
            pages += 1;
            if !more { break; }
        }
        assert!(pages > 1);
        assert_eq!(seen, (1..=16).rev().collect::<Vec<_>>());
        // The same encrypted connection remains usable after all the pages.
        let response = success_response("status", json!({ "ready": true })).to_string();
        let (sent, received) = tokio::join!(send_encrypted_text(&mut host_socket, &mut host, &response), phone_socket.next());
        sent.unwrap();
        let text = received.unwrap().unwrap().into_text().unwrap();
        assert_eq!(phone.open(&general_purpose::STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap(), response.as_bytes());
    }

    #[tokio::test]
    async fn over_relay_no_frame_exceeds_the_cell_and_an_oversized_reply_fails_alone() {
        use crate::relay_e2ee::{begin_e2ee_session, E2eeClientHandshake, HostKeypair, PayloadKind};
        use super::super::{pairing_websocket_config, send_message, wire::{Reassembly, RELAY_MESSAGE_BYTES_LIMIT}};
        use futures_util::StreamExt;
        use tokio_tungstenite::{tungstenite::{protocol::Role, Message}, WebSocketStream};

        let key = HostKeypair::from_secret([7; 32]);
        let handshake = E2eeClientHandshake::new(&key.public_key_b64(), "direct", None).unwrap();
        let (ready, mut host) = begin_e2ee_session(&key, handshake.hello().clone(), "direct", None).unwrap();
        let mut phone = handshake.accept_ready(&serde_json::to_string(&ready).unwrap()).unwrap();
        let (host_io, phone_io) = tokio::io::duplex(64 * 1024);
        let mut host_socket = WebSocketStream::from_raw_socket(host_io, Role::Server, Some(pairing_websocket_config())).await;
        let mut phone_socket = WebSocketStream::from_raw_socket(phone_io, Role::Client, Some(pairing_websocket_config())).await;
        let wire = Wire::new(Transport::Relay);
        let reply = success_response("request-1", json!({ "events": [], "blob": "🦝 \"x\"\n".repeat(400_000) }));
        let notification = json!({ "method": "session.event", "params": { "blob": "y".repeat(2 * 1024 * 1024) } });
        let small = success_response("request-2", json!({ "ready": true }));

        // A phone that does not reassemble fragments: the reply becomes that
        // request's error, the notification is not sent, and the next message
        // opens in counter order.
        for message in [&reply, &notification, &small] {
            send_message(&mut host_socket, &mut host, message, &wire).await.unwrap();
        }
        let mut texts = Vec::new();
        for _ in 0..2 {
            let text = phone_socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(text.len() <= RELAY_MESSAGE_BYTES_LIMIT);
            let opened = phone.open(&general_purpose::STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap();
            texts.push(serde_json::from_slice::<Value>(&opened).unwrap());
        }
        assert_eq!(texts[0]["id"], "request-1");
        assert_eq!(texts[0]["error"]["code"], "message_too_large");
        assert_eq!(texts[1], small);

        // Once it does, the same reply crosses whole, in binary fragments.
        assert!(wire.negotiate(Some(super::super::wire::FRAGMENTS_VERSION.into())));
        let receive = async {
            let mut reassembly = Reassembly::default();
            loop {
                let Message::Binary(frame) = phone_socket.next().await.unwrap().unwrap() else { panic!("expected a fragment") };
                assert!(frame.len() <= RELAY_MESSAGE_BYTES_LIMIT);
                if let Some(message) = reassembly.push(&phone.open(&frame, PayloadKind::Binary).unwrap()).unwrap() {
                    return message;
                }
            }
        };
        let (sent, received) = tokio::join!(send_message(&mut host_socket, &mut host, &reply, &wire), receive);
        sent.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&received).unwrap(), reply);
        let (sent, received) = tokio::join!(send_message(&mut host_socket, &mut host, &small, &wire), phone_socket.next());
        sent.unwrap();
        let text = received.unwrap().unwrap().into_text().unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&phone.open(&general_purpose::STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap(), small);
    }

    #[test]
    fn notification_text_is_bounded_and_single_line() {
        let text = format!("first\n{}", "word ".repeat(80));
        let collapsed = collapse_notification_text(&text);
        assert!(!collapsed.contains('\n'));
        assert!(collapsed.chars().count() <= 160);
        assert!(collapsed.ends_with('…'));
    }

    /// #979: the answers are a map of text to text and nothing else, and the
    /// method is offered only where the attached runtime serves it.
    #[test]
    fn question_answers_are_closed_and_offered_only_with_a_runtime_that_takes_them() {
        let parsed: QuestionsRespondParams = serde_json::from_value(json!({
            "sessionId": "session", "tabId": "tab", "requestId": "request",
            "answers": { "Which one?": "A, B", "Why?": "Because, well" },
        })).unwrap();
        assert_eq!((parsed.session_id.as_str(), parsed.tab_id.as_str(), parsed.request_id.as_str()), ("session", "tab", "request"));
        assert_eq!(parsed.answers["Which one?"], "A, B");
        let skipped: QuestionsRespondParams = serde_json::from_value(json!({ "sessionId": "s", "tabId": "t", "requestId": "r", "answers": {} })).unwrap();
        assert!(skipped.answers.is_empty(), "Skip is an empty answer set");
        for refused in [
            json!({ "sessionId": "s", "tabId": "t", "requestId": "r" }),
            json!({ "sessionId": "s", "tabId": "t", "requestId": "r", "answers": { "Which one?": ["A", "B"] } }),
            json!({ "sessionId": "s", "tabId": "t", "requestId": "r", "answers": {}, "optionId": "allow" }),
        ] {
            assert!(serde_json::from_value::<QuestionsRespondParams>(refused.clone()).is_err(), "{refused}");
        }
        assert_eq!(capabilities(&current_runtime())["questions"], 1);
        assert!(capabilities(&runtime_of(Some("0.2.22"), None)).get("questions").is_none(), "an older runtime has no such operation: the phone shows the question read-only");
    }

    #[test]
    fn permission_response_params_are_closed_and_session_scoped() {
        let parsed: PermissionRespondParams = serde_json::from_value(json!({
            "sessionId": "session",
            "tabId": "tab",
            "requestId": "request",
            "optionId": "allow",
        }))
        .unwrap();
        assert_eq!(parsed.session_id, "session");
        assert_eq!(parsed.tab_id, "tab");
        assert_eq!(parsed.request_id, "request");
        assert_eq!(parsed.option_id, "allow");
        assert!(serde_json::from_value::<PermissionRespondParams>(json!({
            "sessionId": "session",
            "tabId": "tab",
            "requestId": "request",
            "optionId": "allow",
            "paneId": "not accepted",
        }))
        .is_err());
    }

    #[test]
    fn explicit_pairing_uses_its_authenticated_device_identity_without_an_account() {
        let author = effective_user_from_mirror(&device(DeviceProvenance::Explicit, None), None).unwrap();
        assert_eq!(author.user_id, "device-1");
        assert_eq!(author.display_name, "Paresh's phone");
    }

    #[test]
    fn account_pairing_still_requires_its_bound_account() {
        assert!(effective_user_from_mirror(&device(DeviceProvenance::Automatic, Some("user-1")), None).is_err());
        assert!(effective_user_from_mirror(&device(DeviceProvenance::Automatic, Some("other-user")), Some(account())).is_err());
    }

    #[test]
    fn session_send_attachments_are_optional_for_old_clients() {
        let old: SessionSendParams = serde_json::from_value(json!({
            "tabId": "tab",
            "text": "hello",
        }))
        .unwrap();
        assert!(old.attachments.is_empty());

        let with_attachment: SessionSendParams = serde_json::from_value(json!({
            "tabId": "tab",
            "text": "hello",
            "attachments": [{
                "mediaType": "image/png",
                "data": general_purpose::STANDARD.encode([1, 2, 3]),
                "name": "proof.png",
            }],
        }))
        .unwrap();
        assert_eq!(with_attachment.attachments.len(), 1);
        assert!(validate_attachment_payloads(&with_attachment.attachments).is_ok());
    }

    /// A runtime of this build, as the desktop reads it when attaching.
    fn current_runtime() -> crate::local_runtime::client::Build {
        runtime_of(Some(env!("CARGO_PKG_VERSION")), Some(crate::local_runtime::mobile::features()))
    }

    fn runtime_of(version: Option<&str>, named: Option<Value>) -> crate::local_runtime::client::Build {
        let version = version.map(|version| semver::Version::parse(version).unwrap());
        let mobile = named.unwrap_or_else(|| crate::local_runtime::mobile::released_features(version.as_ref()));
        crate::local_runtime::client::Build { version, mobile: mobile.as_object().unwrap().clone(), handover: None }
    }

    /// #730: the phone is told what the runtime its connection reaches can
    /// serve, not what this app could serve through a runtime of its own build.
    #[test]
    fn a_phone_is_offered_only_what_the_attached_runtime_serves() {
        let released = json!({ "transcript": 1, "conditionalLists": 1, "promptImages": 1, "notificationFilters": 1, "prefetch": 1, "prefetchOpen": 1, "prefetchTargets": 1, "sendIds": 1, "sessionControls": 1, "sessionCreate": 1, "macSettings": 1, "terminal": 1 });
        let mut every = released.clone();
        every["closeTab"] = json!(1);
        every["layeredConfiguration"] = json!(1);
        every["questions"] = json!(1);
        every["pin"] = json!(1);
        assert_eq!(capabilities(&current_runtime()), every);
        assert_eq!(capabilities(&runtime_of(Some("0.2.22"), None)), released, "0.2.22 serves those it brought, without naming them; closing a tab, layered configuration, answering questions and pins came later");
        let app_only = json!({ "transcript": 1, "conditionalLists": 1, "promptImages": 1, "notificationFilters": 1, "prefetch": 1, "prefetchOpen": 1, "prefetchTargets": 1 });
        assert_eq!(capabilities(&runtime_of(Some("0.2.21"), None)), app_only,
            "no terminal, session controls, new sessions, Mac settings or send ids from a 0.2.21 runtime");
        assert_eq!(capabilities(&runtime_of(None, None)), app_only, "nor from one that would not say its version");
        // A runtime that names features is taken at its word, at the level this app knows.
        let named = capabilities(&runtime_of(Some("9.0.0"), Some(json!({ "terminal": 2, "sendIds": 0, "sessionCreate": "1", "futureThing": 1 }))));
        assert_eq!(named, json!({ "transcript": 1, "conditionalLists": 1, "promptImages": 1, "notificationFilters": 1, "prefetch": 1, "prefetchOpen": 1, "prefetchTargets": 1, "terminal": 1 }));
    }

    /// #730: an operation the runtime does not know reads as what to do about it.
    #[test]
    fn a_runtime_refusing_an_unknown_operation_says_the_mac_needs_updating() {
        use crate::local_runtime::client::Refused;
        let refused = |message: &str| anyhow::Error::from(Refused { code: "internal".into(), message: message.into() });
        assert_eq!(outdated(refused(crate::local_runtime::mobile::UNSUPPORTED)).to_string(), crate::platform_profile::localize(OUTDATED));
        assert_eq!(outdated(refused(crate::local_runtime::mobile::UNSUPPORTED).context("open the terminal")).to_string(), crate::platform_profile::localize(OUTDATED));
        assert_eq!(outdated(refused("The tab is not running.")).to_string(), "internal: The tab is not running.", "any other refusal is left as it is");
        assert_eq!(outdated(anyhow!("timed out")).to_string(), "timed out");
    }

    #[test]
    fn the_terminal_view_is_offered_with_the_requests_it_needs() {
        // A phone shows its Terminal view only to a Mac that names this.
        assert_eq!(capabilities(&current_runtime())["terminal"], 1);
        let open: TerminalParams = serde_json::from_value(json!({ "worktreeId": "worktree", "tabId": "tab" })).unwrap();
        assert_eq!((open.worktree_id.as_str(), open.tab_id.as_str()), ("worktree", "tab"));
        assert!(serde_json::from_value::<TerminalParams>(json!({ "worktreeId": "worktree", "tabId": "tab", "force": true })).is_err());
    }

    #[test]
    fn session_controls_are_named_and_take_only_their_own_fields() {
        // A phone offers the controls only to a Mac that names them.
        assert_eq!(capabilities(&current_runtime())["sessionControls"], 1);
        let tab: TabControlParams = serde_json::from_value(json!({ "sessionId": "s", "tabId": "t" })).unwrap();
        assert_eq!(tab.into_call(), json!({ "sessionId": "s", "tabId": "t" }));
        assert!(serde_json::from_value::<TabControlParams>(json!({ "sessionId": "s", "tabId": "t", "force": true })).is_err());
        let call = |method, value: Value| serde_json::from_value::<TabSettingParams>(value).unwrap().into_call(method);
        assert_eq!(call("session.setModel", json!({ "sessionId": "s", "tabId": "t", "model": "opus" }))["model"], "opus");
        assert_eq!(call("session.setEffort", json!({ "sessionId": "s", "tabId": "t", "effort": null }))["effort"], Value::Null);
        assert_eq!(call("session.setMode", json!({ "sessionId": "s", "tabId": "t", "mode": "plan" }))["mode"], "plan");
        let handoff: ContinueParams = serde_json::from_value(json!({ "sessionId": "s", "tabId": "t", "prompt": "carry on",
            "tab": { "harness": "codex", "model": "", "permissionMode": "auto" } })).unwrap();
        assert_eq!(serde_json::to_value(&handoff.tab).unwrap(), json!({ "harness": "codex", "model": "", "effort": null, "permissionMode": "auto" }));
        assert!(serde_json::from_value::<ContinueParams>(json!({ "sessionId": "s", "tabId": "t", "prompt": "p",
            "tab": { "harness": "codex", "transport": "experimentalCodexStdio" } })).is_err(), "a phone cannot choose a transport");
    }

    #[test]
    fn sends_and_notes_take_a_message_id_only_this_mac_reports_it_understands() {
        // A phone sends the id only after `sync.capabilities` names it (#675).
        assert_eq!(capabilities(&current_runtime())["sendIds"], 1);
        let id = "0b8f6a52-0c1f-4c35-9d0e-1d5d5a7d1c11";
        let send: SessionSendParams = serde_json::from_value(json!({ "tabId": "tab", "text": "hello", "clientMessageId": id })).unwrap();
        assert_eq!(send.client_message_id.as_deref(), Some(id));
        let post: ChatPostParams = serde_json::from_value(json!({ "worktreeId": "worktree", "body": "hello", "clientMessageId": id })).unwrap();
        assert_eq!(post.client_message_id.as_deref(), Some(id));
        // Older phones send neither; other unknown fields are still refused.
        let old: ChatPostParams = serde_json::from_value(json!({ "worktreeId": "worktree", "body": "hello" })).unwrap();
        assert_eq!(old.client_message_id, None);
        assert!(serde_json::from_value::<SessionSendParams>(json!({ "tabId": "tab", "text": "hello", "messageId": id })).is_err());

        assert_eq!(checked_message_id(Some(id.into())).unwrap().as_deref(), Some(id));
        assert_eq!(checked_message_id(None).unwrap(), None);
        for bad in ["short", &"x".repeat(129), "has space in it", "../../etc/passwd"] {
            assert!(checked_message_id(Some(bad.into())).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_send_digest_matches_a_repeat_and_changes_with_any_edit() {
        let attachment = |name: &str, data: &[u8]| RemoteAttachmentInput {
            media_type: "image/png".into(),
            data: general_purpose::STANDARD.encode(data),
            name: Some(name.into()),
        };
        let first = send_digest("Run the tests", &[attachment("a.png", &[1])]);
        // The agent gets trimmed text: surrounding space is the same message.
        assert_eq!(first, send_digest("  Run the tests\n", &[attachment("a.png", &[1])]));
        for edited in [
            send_digest("Run the tests again", &[attachment("a.png", &[1])]),
            send_digest("Run the tests", &[]),
            send_digest("Run the tests", &[attachment("a.png", &[2])]),
            send_digest("Run the tests", &[attachment("b.png", &[1])]),
            send_digest("Run the tests", &[attachment("a.png", &[1]), attachment("a.png", &[1])]),
        ] {
            assert_ne!(first, edited);
        }
    }

    /// What the runtime was asked to send: tab, text, attachment count and id.
    type OwnerCalls = std::cell::RefCell<Vec<(String, String, usize, Option<String>)>>;

    /// A phone send through `send_once`, against a runtime answering
    /// `answer` as its JSON would read. Records what the runtime was asked.
    fn sends(ids: &SendIds, calls: &OwnerCalls, text: &str, id: Option<&str>, answer: Value) -> Result<Value> {
        let params: SessionSendParams = serde_json::from_value(json!({
            "tabId": "tab", "text": text, "clientMessageId": id,
            "attachments": [{ "mediaType": "image/png", "data": general_purpose::STANDARD.encode([1]), "name": "a.png" }],
        })).unwrap();
        send_once(ids, params, |tab_id, text, attachments, message| {
            calls.borrow_mut().push((tab_id.into(), text.into(), attachments.len(), message.map(str::to_owned)));
            Ok(serde_json::from_value(answer)?)
        })
    }

    #[test]
    fn a_phone_starting_a_session_again_after_a_lost_reply_gets_the_first_one() {
        let dir = tempfile::tempdir().unwrap();
        let ids = SendIds::at(dir.path().join("sends.json"));
        let made = std::cell::Cell::new(0);
        let create = || { made.set(made.get() + 1); Ok(json!({ "sessionId": format!("session-{}", made.get()), "tabId": "tab" })) };
        let first = create_once(&ids, Some("draft-0001"), "request".into(), create).unwrap();
        assert_eq!(create_once(&ids, Some("draft-0001"), "request".into(), create).unwrap(), first);
        assert_eq!(made.get(), 1);
        // The id with another request is refused, and makes nothing.
        assert_eq!(create_once(&ids, Some("draft-0001"), "another request".into(), create).unwrap_err().to_string(), crate::platform_profile::localize(ID_REUSED));
        assert_eq!(made.get(), 1);
        // A create that failed made nothing to answer with: the next try makes one.
        assert!(create_once(&ids, Some("draft-0002"), "request".into(), || bail!("Codex is not installed on this Mac.")).is_err());
        assert_eq!(create_once(&ids, Some("draft-0002"), "request".into(), create).unwrap()["sessionId"], "session-2");
        // An id never names a tab's send: the same draft id's message to the new tab is its own.
        assert!(ids.once(SendKey { tab_id: "tab".into(), client_message_id: "draft-0001".into() }, "message".into(), || Ok(Reply::Settled(json!({"status":"sent"})))).is_ok());
        // Without an id every request makes a session.
        create_once(&ids, None, "request".into(), create).unwrap();
        create_once(&ids, None, "request".into(), create).unwrap();
        assert_eq!(made.get(), 4);
    }

    #[test]
    fn a_phone_names_projects_by_id_and_never_sends_a_path() {
        let named = capabilities(&current_runtime());
        assert_eq!((named["sessionCreate"].clone(), named["macSettings"].clone()), (json!(1), json!(1)));
        let create: SessionCreateParams = serde_json::from_value(json!({ "projectId": "abc", "useWorktree": true, "agent": "codex", "model": "gpt-5", "effort": "high", "mode": "auto", "title": "Fix it", "text": "Fix the login", "clientMessageId": "0b8f6a52-0c1f-4c35-9d0e-1d5d5a7d1c11" })).unwrap();
        assert_eq!((create.project_id.as_deref(), create.use_worktree, create.agent.as_str()), (Some("abc"), true, "codex"));
        for path in [json!({ "projectPath": "/Users/me/repo" }), json!({ "cwd": "/tmp" }), json!({ "baseRef": "main" })] {
            let mut params = json!({ "quick": true, "agent": "codex", "text": "hi" });
            params.as_object_mut().unwrap().extend(path.as_object().unwrap().clone());
            assert!(serde_json::from_value::<SessionCreateParams>(params).is_err(), "a phone cannot name a folder");
        }
        assert!(serde_json::from_value::<MacSettingsPatch>(json!({ "nativeCodex": true, "linearApiKey": "lin_secret" })).is_err());

        let _home = store::temp_home();
        let root = store::root().unwrap();
        for name in ["repo", "old"] { std::fs::create_dir_all(root.join(name)).unwrap(); }
        let repo = store::projects::add(root.join("repo").to_str().unwrap()).unwrap();
        let old = store::projects::add(root.join("old").to_str().unwrap()).unwrap();
        store::projects::update(&old.path, store::projects::ProjectPatch { archived: Some(true), ..Default::default() }).unwrap();
        store::projects::update(&repo.path, store::projects::ProjectPatch { repository_settings: Some(store::projects::RepositorySettings { files_to_copy: vec![".env*".into()] }), ..Default::default() }).unwrap();
        let projects = phone_projects().unwrap();
        assert_eq!(projects, vec![json!({ "id": store::projects::public_id(&repo.path), "name": "repo", "git": false, "repositorySettings": {"filesToCopy": [".env*"]}, "lastUsed": false })]);
        assert!(!serde_json::to_string(&projects).unwrap().contains(&root.to_string_lossy().into_owned()));
        assert_eq!(store::projects::by_public_id(projects[0]["id"].as_str().unwrap()).unwrap().path, repo.path);
    }

    #[test]
    fn a_send_the_agent_has_is_answered_again_without_sending() {
        let dir = tempfile::tempdir().unwrap();
        let ids = SendIds::at(dir.path().join("sends.json"));
        let calls = std::cell::RefCell::new(Vec::new());
        let sent = json!({ "status": "sent", "queued": false });
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": false, "events": [] })).unwrap(), sent);
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": false, "events": [] })).unwrap(), sent);
        assert_eq!(*calls.borrow(), vec![("tab".into(), "Ship it".into(), 1, Some("draft-0001".into()))]);
        // The same id with another message is refused before the runtime sees it.
        assert_eq!(sends(&ids, &calls, "Ship it now", Some("draft-0001"), json!({ "queued": false, "events": [] })).unwrap_err().to_string(), crate::platform_profile::localize(ID_REUSED));
        // Without an id (an older phone) every send goes through.
        sends(&ids, &calls, "Ship it", None, json!({ "queued": false, "events": [] })).unwrap();
        sends(&ids, &calls, "Ship it", None, json!({ "queued": false, "events": [] })).unwrap();
        assert_eq!(calls.borrow()[1..], [("tab".into(), "Ship it".into(), 1, None), ("tab".into(), "Ship it".into(), 1, None)]);
    }

    #[test]
    fn a_queued_send_goes_to_the_runtime_on_every_repeat_until_it_is_delivered() {
        let dir = tempfile::tempdir().unwrap();
        let ids = SendIds::at(dir.path().join("sends.json"));
        let calls = std::cell::RefCell::new(Vec::new());
        let queued = json!({ "status": "sent", "queued": true });
        // The agent's turn is open, and the reply saying so is lost.
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": true, "events": [] })).unwrap(), queued);
        // Not answered from here: the runtime is asked, with the id, and finds
        // the copy queued under the dropped connection.
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": true, "events": [], "repeat": "requeued" })).unwrap(), queued);
        // An older runtime knows no ids, and queues it again: as on a Mac
        // before #675, never lost.
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": true, "events": [] })).unwrap(), queued);
        // Being typed to the agent right now: not known yet, so not sent.
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": true, "events": [], "repeat": "delivering" })).unwrap_err().to_string(), crate::platform_profile::localize(STILL_SENDING));
        // Delivered: that settles it, and later repeats are answered here.
        let sent = json!({ "status": "sent", "queued": false });
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": false, "events": [], "repeat": "delivered" })).unwrap(), sent);
        assert_eq!(sends(&ids, &calls, "Ship it", Some("draft-0001"), json!({ "queued": false, "events": [] })).unwrap(), sent);
        assert_eq!(calls.borrow().len(), 5);
        assert!(calls.borrow().iter().all(|call| *call == ("tab".into(), "Ship it".into(), 1, Some("draft-0001".into()))));
    }

    #[test]
    fn a_note_posted_again_adds_nothing_and_returns_the_first() {
        let _home = store::temp_home();
        let lock = Mutex::new(());
        let note = |id: &str, body: &str, client: Option<&str>| ChatNote {
            id: id.into(),
            body: body.into(),
            created_at: 1,
            author: NoteAuthor { user_id: "user-1".into(), display_name: "Paresh".into() },
            promoted_to: Vec::new(),
            client_message_id: client.map(str::to_owned),
        };
        let saved = || load_notes().unwrap().sessions.remove("worktree").unwrap_or_default().into_iter().map(|note| note.id).collect::<Vec<_>>();

        let (first, added) = add_note(&lock, "worktree", note("note-1", "Deploying at 5", Some("draft-1"))).unwrap();
        assert!(added);
        let (again, added) = add_note(&lock, "worktree", note("note-2", "Deploying at 5", Some("draft-1"))).unwrap();
        assert!(!added);
        assert_eq!(again.id, first.id);
        assert_eq!(saved(), vec!["note-1"]);

        // Another draft, a phone that sends no id, or another worktree: added.
        assert!(add_note(&lock, "worktree", note("note-3", "Deploying at 5", Some("draft-2"))).unwrap().1);
        assert!(add_note(&lock, "worktree", note("note-4", "Deploying at 5", None)).unwrap().1);
        assert!(add_note(&lock, "worktree", note("note-5", "Deploying at 5", None)).unwrap().1);
        assert!(add_note(&lock, "elsewhere", note("note-6", "Deploying at 5", Some("draft-1"))).unwrap().1);
        // The id with other text: refused, and nothing written.
        assert_eq!(add_note(&lock, "worktree", note("note-7", "Deploying at 6", Some("draft-1"))).unwrap_err().to_string(), crate::platform_profile::localize(ID_REUSED));
        assert_eq!(saved(), vec!["note-1", "note-3", "note-4", "note-5"]);
    }

    #[test]
    fn a_note_posted_again_is_found_with_its_promotions_and_not_added_twice() {
        let note = |id: &str, body: &str, client: Option<&str>| ChatNote {
            id: id.into(),
            body: body.into(),
            created_at: 1,
            author: NoteAuthor { user_id: "user-1".into(), display_name: "Paresh".into() },
            promoted_to: Vec::new(),
            client_message_id: client.map(str::to_owned),
        };
        let mut first = note("note-1", "Deploying at 5", Some("draft-1"));
        first.promoted_to.push(NotePromotion { tab_id: "claude".into(), seq: 4 });
        let notes = vec![note("note-0", "Deploying at 5", None), first];

        let repeat = note("note-2", "Deploying at 5", Some("draft-1"));
        let found = posted_before(&notes, &repeat).unwrap().expect("the note posted first");
        assert_eq!(found.id, "note-1");
        assert_eq!(found.promoted_to, vec![NotePromotion { tab_id: "claude".into(), seq: 4 }]);

        // A new draft, or a phone that sends no id, adds a note as before.
        assert!(posted_before(&notes, &note("note-3", "Deploying at 5", Some("draft-2"))).unwrap().is_none());
        assert!(posted_before(&notes, &note("note-4", "Deploying at 5", None)).unwrap().is_none());
        // The same id with other text is refused, not answered with this note.
        let error = posted_before(&notes, &note("note-5", "Deploying at 6", Some("draft-1"))).unwrap_err();
        assert_eq!(error.to_string(), crate::platform_profile::localize(ID_REUSED));

        // Older phones list notes too; one posted without an id carries no new key.
        assert_eq!(serde_json::to_value(&notes[0]).unwrap().get("clientMessageId"), None);
        assert_eq!(serde_json::to_value(&notes[1]).unwrap()["clientMessageId"], "draft-1");
    }

    #[test]
    fn notes_saved_before_promotions_were_recorded_still_load_and_list_unchanged() {
        let saved: NotesFile = serde_json::from_value(json!({ "sessions": { "worktree": [{
            "id": "note-1",
            "body": "hello",
            "createdAt": 1,
            "author": { "userId": "user-1", "displayName": "Paresh" },
        }] } }))
        .unwrap();
        let note = &saved.sessions["worktree"][0];
        assert!(note.promoted_to.is_empty());
        // Old phones read `chat.list` too; a note never sent carries no new key.
        assert_eq!(serde_json::to_value(note).unwrap().get("promotedTo"), None);
    }

    #[test]
    fn promoting_notes_records_one_promotion_per_tab() {
        let note = |id: &str| ChatNote {
            id: id.into(),
            body: format!("{id} body"),
            created_at: 1,
            author: NoteAuthor { user_id: "user-1".into(), display_name: "Paresh".into() },
            promoted_to: Vec::new(),
            client_message_id: None,
        };
        let mut notes = vec![note("a"), note("b"), note("c")];
        let (a, c, gone) = ("a".to_string(), "c".to_string(), "gone".to_string());
        let promotion = |tab_id: &str, seq| NotePromotion { tab_id: tab_id.into(), seq };

        assert!(mark_promoted(&mut notes, &HashSet::from([&a, &c]), &promotion("claude", 4)));
        assert!(mark_promoted(&mut notes, &HashSet::from([&a]), &promotion("codex", 9)));
        assert!(mark_promoted(&mut notes, &HashSet::from([&a]), &promotion("claude", 12)));
        assert_eq!(notes[0].promoted_to, vec![promotion("codex", 9), promotion("claude", 12)]);
        assert!(notes[1].promoted_to.is_empty());
        assert_eq!(notes[2].promoted_to, vec![promotion("claude", 4)]);
        assert_eq!(
            serde_json::to_value(&notes[2]).unwrap()["promotedTo"],
            json!([{ "tabId": "claude", "seq": 4 }]),
        );

        // A note trimmed away while its message was being sent is skipped.
        assert!(!mark_promoted(&mut notes, &HashSet::from([&gone]), &promotion("claude", 20)));
    }

    #[test]
    fn remote_attachments_are_type_count_and_size_bounded() {
        let attachment = |media_type: &str, data: String| RemoteAttachmentInput {
            media_type: media_type.into(),
            data,
            name: Some("image.png".into()),
        };
        assert!(validate_attachment_payloads(&[attachment("application/pdf", general_purpose::STANDARD.encode([1]))]).is_ok());
        assert!(validate_attachment_payloads(&[attachment("", general_purpose::STANDARD.encode([1]))]).is_err());
        let too_many = (0..=ATTACHMENT_COUNT_LIMIT)
            .map(|_| attachment("image/png", general_purpose::STANDARD.encode([1])))
            .collect::<Vec<_>>();
        assert!(validate_attachment_payloads(&too_many).is_err());
        assert!(validate_attachment_payloads(&[attachment(
            "image/png",
            general_purpose::STANDARD.encode(vec![0; ATTACHMENT_BYTES_LIMIT + 1]),
        )])
        .is_err());
        assert_eq!(safe_attachment_name(Some("../../design brief.pdf")), "design_brief.pdf");
    }

    // ---- notification kinds and filters (#990) ----------------------------------

    fn titled() -> Option<String> { Some("Fix login".into()) }

    fn notice(runtime: &MobileRuntime, payload: Payload) -> Option<MobileNotification> {
        runtime.agent_notification(&event(1, payload), titled)
    }

    fn ended(status: TurnStatus, final_text: Option<&str>, auth_failed: bool) -> Payload {
        Payload::TurnCompleted { status, final_text: final_text.map(str::to_string), usage: None, duration_ms: None, head: None, auth_failed, detail: None }
    }

    fn asked(request_id: &str, questions: Vec<crate::events::Question>) -> Payload {
        Payload::QuestionsAsked { request_id: request_id.into(), tool_use_id: "tool".into(), questions }
    }

    fn question(text: &str, options: &[&str], multi_select: bool) -> crate::events::Question {
        crate::events::Question {
            question: text.into(), header: None, multi_select, free_text: false,
            options: options.iter().map(|label| crate::events::QuestionOption { label: label.to_string(), description: None }).collect(),
        }
    }

    fn permission(request_id: &str, title: Option<&str>) -> Payload {
        Payload::PermissionRequested {
            request_id: request_id.into(), tool_use_id: "tool".into(), tool_name: "Bash".into(), input: json!({"command": "ls"}),
            cwd: None, title: title.map(str::to_string), description: None, reason: None,
            options: vec![
                crate::events::PermissionOption { id: "allow".into(), label: "Allow".into(), kind: crate::events::PermissionOptionKind::AllowOnce },
                crate::events::PermissionOption { id: "deny".into(), label: "Deny".into(), kind: crate::events::PermissionOptionKind::Deny },
            ],
        }
    }

    fn limited(status: &str) -> Payload {
        Payload::RateLimited { status: Some(status.into()), resets_at: None, window: None, message: None }
    }

    fn goal(status: crate::events::GoalStatus) -> Payload {
        Payload::GoalUpdated { goal: crate::events::Goal { objective: "Ship".into(), status, token_budget: None, tokens_used: 1 } }
    }

    #[test]
    fn each_agent_event_makes_a_notice_of_its_kind_named_by_its_session() {
        let runtime = MobileRuntime::new();
        let finished = notice(&runtime, ended(TurnStatus::Ok, Some("All\n done."), false)).unwrap();
        assert_eq!((finished.kind, finished.title.as_str(), finished.body.as_str()), (NoticeKind::Finished, "Fix login finished", "All done."));
        assert_eq!(finished.session_title.as_deref(), Some("Fix login"));
        assert_eq!((finished.session_id.as_deref(), finished.tab_id.as_deref()), (Some("session"), Some("tab")));

        let failed = notice(&runtime, ended(TurnStatus::Error, Some("boom"), false)).unwrap();
        assert_eq!((failed.kind, failed.title.as_str(), failed.body.as_str()), (NoticeKind::Failed, "Fix login stopped on an error", "boom"));
        let signed_out = notice(&runtime, ended(TurnStatus::Ok, None, true)).unwrap();
        assert_eq!((signed_out.kind, signed_out.body.as_str()), (NoticeKind::Failed, crate::recovery::RecoveryKind::SignedOut.message()));
        let aborted_signed_out = notice(&runtime, ended(TurnStatus::Aborted, None, true)).unwrap();
        assert_eq!(aborted_signed_out.kind, NoticeKind::Failed, "aborted by an error");
        let stopped = notice(&runtime, ended(TurnStatus::Aborted, None, false)).unwrap();
        assert_eq!((stopped.kind, stopped.body.as_str()), (NoticeKind::Finished, crate::platform_profile::localize("An agent turn finished on your Mac.").as_str()), "stopped by the person: a turn's end, as an old phone was always told");
        // An error mid-turn is told by the turn it ends, which an abort is down to.
        assert!(notice(&runtime, Payload::Error { message: "Connection write failed: broken pipe".into(), fatal: false, detail: None }).is_none());
        let errored = notice(&runtime, ended(TurnStatus::Aborted, None, false)).unwrap();
        assert_eq!((errored.kind, errored.body.as_str()), (NoticeKind::Failed, crate::recovery::RecoveryKind::Disconnected.message()), "aborted by an error, not by the person: told in the error's allowlisted words");
        assert_eq!(notice(&runtime, ended(TurnStatus::Aborted, None, false)).unwrap().kind, NoticeKind::Finished, "the error was that turn's, not the next one's");
        // A non-fatal error the agent went on past: a person's stop later is still theirs.
        assert!(notice(&runtime, Payload::Error { message: "Connection write failed: broken pipe".into(), fatal: false, detail: None }).is_none());
        assert!(notice(&runtime, Payload::ModelRequestStarted).is_none());
        assert_eq!(notice(&runtime, ended(TurnStatus::Aborted, None, false)).unwrap().kind, NoticeKind::Finished, "stopped by the person after the agent carried on");
        // A fatal one stays the turn's, whatever follows it.
        assert!(notice(&runtime, Payload::Error { message: "Connection write failed: broken pipe".into(), fatal: true, detail: None }).is_none());
        assert!(notice(&runtime, Payload::ModelRequestStarted).is_none());
        assert_eq!(notice(&runtime, ended(TurnStatus::Aborted, None, false)).unwrap().kind, NoticeKind::Failed, "a fatal error ended it");
        assert!(notice(&runtime, Payload::ApiRetry { attempt: 3, max_retries: 3, reason: Some("overloaded".into()) }).is_none());
        assert_eq!(notice(&runtime, ended(TurnStatus::Aborted, None, false)).unwrap().kind, NoticeKind::Failed, "retries ran out");
        assert!(notice(&runtime, Payload::ApiRetry { attempt: 1, max_retries: 3, reason: None }).is_none());
        assert_eq!(notice(&runtime, ended(TurnStatus::Aborted, None, false)).unwrap().kind, NoticeKind::Finished, "a retry that may still succeed is no failure");

        let answerable = notice(&runtime, asked("q1", vec![question("Which database?", &["Postgres", "SQLite"], false)])).unwrap();
        assert_eq!((answerable.kind, answerable.title.as_str(), answerable.body.as_str()), (NoticeKind::Question, "Fix login needs your answer", "Which database?"));
        assert_eq!(serde_json::to_value(&answerable).unwrap()["question"], json!({"requestId": "q1", "options": [{"label": "Postgres"}, {"label": "SQLite"}]}));
        assert!(notice(&runtime, asked("q1", vec![question("Which database?", &["Postgres"], false)])).is_none(), "the same ask published again is not news");
        for (id, questions) in [
            ("q2", vec![question("Which?", &["A", "B"], true)]),
            ("q3", vec![question("Which?", &[], false)]),
            ("q4", vec![question("One?", &["A"], false), question("Two?", &["B"], false)]),
            ("q5", vec![question("Which  database?", &["A"], false)]),
        ] {
            let unanswerable = notice(&runtime, asked(id, questions)).unwrap();
            assert_eq!(unanswerable.kind, NoticeKind::Question);
            assert!(unanswerable.question.is_none(), "{id}: not answerable from the notice alone");
        }

        let approval = notice(&runtime, permission("p1", Some("Run ls"))).unwrap();
        assert_eq!((approval.kind, approval.title.as_str(), approval.body.as_str()), (NoticeKind::Approval, "Fix login needs approval", "Run: ls"), "the command itself, not the request's title");
        assert_eq!(serde_json::to_value(&approval).unwrap()["approval"], json!({"requestId": "p1"}));
        // Allow and Deny only where the notice shows all that is allowed.
        let asking = |id: &str, input: Value, title: Option<&str>, options: Vec<crate::events::PermissionOption>| {
            let Payload::PermissionRequested { tool_use_id, tool_name, cwd, description, reason, .. } = permission(id, None) else { unreachable!() };
            Payload::PermissionRequested { request_id: id.into(), tool_use_id, tool_name, input, cwd, title: title.map(str::to_string), description, reason, options }
        };
        let Payload::PermissionRequested { options: allow_deny, .. } = permission("p0", None) else { unreachable!() };
        let long = "x".repeat(200);
        let cut_short = notice(&runtime, asking("p2", json!({"command": long}), None, allow_deny.clone())).unwrap();
        assert!(cut_short.body.ends_with('…') && cut_short.approval.is_none(), "a command cut short is answered in the session");
        let folded = notice(&runtime, asking("p3", json!({"command": "cd /tmp\nrm -rf build"}), None, allow_deny.clone())).unwrap();
        assert_eq!((folded.body.as_str(), folded.approval.is_none()), ("Run: cd /tmp rm -rf build", true), "a command folded onto one line is not what runs");
        let no_command = notice(&runtime, asking("p4", json!({"file_path": "/src/main.rs"}), Some("Edit main.rs"), allow_deny.clone())).unwrap();
        assert_eq!((no_command.body.as_str(), no_command.approval.is_none()), ("Edit main.rs", true), "an edit's notice does not show the change");
        assert_eq!(notice(&runtime, asking("p5", json!({}), None, allow_deny.clone())).unwrap().body, "Bash wants permission to run.");
        // Other ids (OpenCode's `once`/`reject`): still a notice, with no Allow and Deny to answer it.
        let other_ids = vec![
            crate::events::PermissionOption { id: "once".into(), label: "Allow once".into(), kind: crate::events::PermissionOptionKind::AllowOnce },
            crate::events::PermissionOption { id: "reject".into(), label: "Deny".into(), kind: crate::events::PermissionOptionKind::Deny },
        ];
        let unanswerable = notice(&runtime, asking("p6", json!({"command": "ls"}), None, other_ids)).unwrap();
        assert_eq!((unanswerable.kind, unanswerable.approval), (NoticeKind::Approval, None));

        assert!(notice(&runtime, limited("allowed_warning")).is_none(), "a warning is not a limit");
        let limit = notice(&runtime, limited("rejected")).unwrap();
        assert_eq!((limit.kind, limit.title.as_str()), (NoticeKind::UsageLimit, "Fix login reached a usage limit"));
        assert!(notice(&runtime, limited("rejected")).is_none(), "the same limit is noticed once");
        // An old phone was told of every turn's end, and still is: this one stopped on the limit.
        let after_limit = notice(&runtime, ended(TurnStatus::Aborted, None, false)).unwrap();
        assert_eq!((after_limit.kind, after_limit.body.as_str()), (NoticeKind::Failed, crate::recovery::RecoveryKind::UsageLimit.message()));
        assert!(notice(&runtime, limited("rejected")).is_none(), "reported again before the next turn: noticed already");
        assert!(notice(&runtime, Payload::TurnStarted { model: None, provider_session_id: None, prompt_seq: None, started_by: None, initiating_prompt: None }).is_none());
        assert_eq!(notice(&runtime, goal(crate::events::GoalStatus::UsageLimited)).unwrap().kind, NoticeKind::UsageLimit, "a new turn may reach it again");
        assert!(notice(&runtime, goal(crate::events::GoalStatus::UsageLimited)).is_none());
        assert!(notice(&runtime, goal(crate::events::GoalStatus::Active)).is_none());
        assert!(notice(&runtime, Payload::ModelRequestStarted).is_none());

        let untitled = MobileRuntime::new().agent_notification(&event(1, ended(TurnStatus::Ok, None, false)), || None).unwrap();
        assert_eq!(untitled.title, "An agent finished");
        assert!(serde_json::to_value(&untitled).unwrap().get("sessionTitle").is_none());
        let wire = serde_json::to_value(&finished).unwrap();
        assert_eq!(wire["kind"], "finished");
        assert!(wire.get("question").is_none() && wire.get("approval").is_none());
    }

    #[test]
    fn each_tab_asks_by_its_own_request_ids_and_a_new_turn_asks_anew() {
        let runtime = MobileRuntime::new();
        let in_tab = |tab: &str, payload: Payload| AgentEvent { tab_id: tab.into(), ..event(1, payload) };
        let started = || Payload::TurnStarted { model: None, provider_session_id: None, prompt_seq: None, started_by: None, initiating_prompt: None };
        // ACP and Codex number their asks per agent process: two tabs' first asks share an id.
        for payload in [|| asked("acp:1", vec![question("Which?", &["A"], false)]), || permission("1", None)] {
            assert!(runtime.agent_notification(&in_tab("one", payload()), titled).is_some());
            assert!(runtime.agent_notification(&in_tab("two", payload()), titled).is_some(), "another tab's ask with the same id is news");
            assert!(runtime.agent_notification(&in_tab("two", payload()), titled).is_none(), "the same ask published again is not");
            assert!(runtime.agent_notification(&AgentEvent { session_id: "other".into(), ..in_tab("one", payload()) }, titled).is_some(), "nor is a tab of the same id in another session the same");
        }
        // The agent restarted: a new turn, its ids from one again.
        assert!(runtime.agent_notification(&in_tab("one", started()), titled).is_none());
        assert!(runtime.agent_notification(&in_tab("one", permission("1", None)), titled).is_some(), "a new turn's ask is news");
        assert!(runtime.agent_notification(&in_tab("two", permission("1", None)), titled).is_none(), "another tab's turn goes on");
    }

    #[test]
    fn a_pull_request_notice_is_sent_once_for_its_session() {
        use crate::issue_pipeline::engine::{PhoneNotice, PhoneNoticeKind};
        let runtime = MobileRuntime::new();
        let author = crate::issue_pipeline::SessionRef { session_id: "session".into(), tab_id: "tab".into() };
        let failed = PhoneNotice { key: "p:needsYou:1".into(), kind: PhoneNoticeKind::ChecksFailed, pull_request: "Open a pull request".into(), detail: "Failed: test.".into(), author: author.clone(), at: Utc::now() };
        let notification = runtime.pipeline_notification(failed.clone(), titled()).unwrap();
        assert_eq!((notification.kind, notification.title.as_str(), notification.body.as_str()), (NoticeKind::PrChecksFailed, "Checks failed on Open a pull request", "Failed: test."));
        assert_eq!((notification.session_id.as_deref(), notification.tab_id.as_deref(), notification.session_title.as_deref()), (Some("session"), Some("tab"), Some("Fix login")));
        assert_eq!(serde_json::to_value(&notification).unwrap()["kind"], "pr_checks_failed");
        assert!(runtime.pipeline_notification(failed, titled()).is_none(), "the same news announced again");
        let merged = PhoneNotice { key: "p:merged:2".into(), kind: PhoneNoticeKind::Merged, pull_request: "Open a pull request".into(), detail: "TerminalX merged pull request #7.".into(), author, at: Utc::now() };
        let notification = runtime.pipeline_notification(merged.clone(), titled()).unwrap();
        assert_eq!((notification.kind, notification.title.as_str()), (NoticeKind::PrMerged, "Open a pull request merged"));
        assert_eq!(serde_json::to_value(&notification).unwrap()["kind"], "pr_merged");
        // The app restarted inside the window the pipeline still calls it news: sent before, if at all.
        let restarted = MobileRuntime::new();
        let earlier = PhoneNotice { at: restarted.started - chrono::TimeDelta::minutes(2), ..merged };
        assert!(restarted.pipeline_notification(earlier.clone(), titled()).is_none(), "news from before this app started");
        assert!(restarted.pipeline_notification(PhoneNotice { at: restarted.started, ..earlier }, titled()).is_some(), "news since is sent");
    }

    fn of(kind: NoticeKind, session: &str) -> MobileNotification {
        MobileNotification { seq: 1, epoch: "e".into(), title: "t".into(), body: "b".into(), session_id: Some(session.into()), tab_id: Some("tab".into()), kind, session_title: None, question: None, approval: None, bot_question: None }
    }

    fn filter(value: Value) -> NotificationFilter {
        serde_json::from_value(value).unwrap()
    }

    const KINDS: [NoticeKind; 7] = [NoticeKind::Question, NoticeKind::Approval, NoticeKind::Finished, NoticeKind::Failed, NoticeKind::UsageLimit, NoticeKind::PrChecksFailed, NoticeKind::PrMerged];

    #[test]
    fn a_filter_sends_by_kind_scope_and_each_session_override() {
        assert!(KINDS.iter().all(|kind| admitted(None, &of(*kind, "a"))), "no filter: everything");
        assert!(KINDS.iter().all(|kind| admitted(Some(&filter(json!({}))), &of(*kind, "a"))), "an empty filter: everything");

        let kinds = filter(json!({ "kinds": ["question", "pr_merged", "someday_kind"] }));
        let sent: Vec<_> = KINDS.into_iter().filter(|kind| kinds.admits(&of(*kind, "a"))).collect();
        assert_eq!(sent, [NoticeKind::Question, NoticeKind::PrMerged], "an unknown kind is ignored");
        assert!(!KINDS.iter().any(|kind| filter(json!({ "kinds": [] })).admits(&of(*kind, "a"))));

        let only = filter(json!({ "sessions": { "scope": "only", "ids": ["a"] } }));
        assert!(only.admits(&of(NoticeKind::Finished, "a")));
        assert!(!only.admits(&of(NoticeKind::Finished, "b")));
        assert!(filter(json!({ "sessions": { "scope": "all" } })).admits(&of(NoticeKind::Finished, "b")));

        let overrides = filter(json!({
            "kinds": ["finished"],
            "sessions": { "scope": "only", "ids": ["a", "muted"] },
            "overrides": { "muted": "mute", "loud": "everything", "asks": "needsMe" },
        }));
        assert!(!KINDS.iter().any(|kind| overrides.admits(&of(*kind, "muted"))), "mute sends nothing, in scope or not");
        assert!(KINDS.iter().all(|kind| overrides.admits(&of(*kind, "loud"))), "everything, whatever kinds and scope say");
        let asks: Vec<_> = KINDS.into_iter().filter(|kind| overrides.admits(&of(*kind, "asks"))).collect();
        assert_eq!(asks, [NoticeKind::Question, NoticeKind::Approval], "needsMe: questions and approvals, out of scope too");
        let plain: Vec<_> = KINDS.into_iter().filter(|kind| overrides.admits(&of(*kind, "a"))).collect();
        assert_eq!(plain, [NoticeKind::Finished]);
        assert!(!overrides.admits(&of(NoticeKind::Finished, "b")), "out of scope, no override");
    }

    #[test]
    fn subscribing_with_empty_params_still_takes_everything_and_unknown_fields_are_refused() {
        let empty: SubscribeNotificationsParams = parse_params(json!({})).unwrap();
        assert!(empty.filter.is_none());
        let filtered: SubscribeNotificationsParams = parse_params(json!({ "filter": { "kinds": ["question"] } })).unwrap();
        assert_eq!(filtered.filter, Some(filter(json!({ "kinds": ["question"] }))));
        assert!(parse_params::<SubscribeNotificationsParams>(json!({ "since": 3 })).is_err());
        assert!(parse_params::<SubscribeNotificationsParams>(json!({ "filter": { "machines": [] } })).is_err());
        assert!(parse_params::<SubscribeNotificationsParams>(json!({ "filter": { "sessions": { "scope": "only", "ids": [], "extra": 1 } } })).is_err());
        assert!(parse_params::<SubscribeNotificationsParams>(json!({ "filter": { "sessions": { "scope": "some" } } })).is_err());
        assert!(parse_params::<SubscribeNotificationsParams>(json!({ "filter": { "overrides": { "a": "loud" } } })).is_err());
        let missed: MissedNotificationsParams = parse_params(json!({ "lastSeenSeq": 0 })).unwrap();
        assert!(missed.filter.is_none(), "missedSince as before");
        assert!(parse_params::<MissedNotificationsParams>(json!({ "lastSeenSeq": 0, "filters": {} })).is_err());
    }

    #[test]
    fn missed_notices_and_each_connection_are_held_to_its_filter() {
        let runtime = MobileRuntime::new();
        let (old_tx, mut old_rx) = mpsc::channel(16);
        let (new_tx, mut new_rx) = mpsc::channel(16);
        runtime.register_client("old", old_tx, Default::default(), ConnectionFilter::default(), Default::default());
        let chosen = ConnectionFilter::default();
        *chosen.lock().unwrap() = Some(("subscription".into(), filter(json!({ "kinds": ["question"] }))));
        runtime.register_client("new", new_tx, Default::default(), chosen, Default::default());
        let ask = runtime.agent_notification(&event(1, asked("q", vec![question("Which?", &["A"], false)])), titled).unwrap();
        let end = runtime.agent_notification(&event(2, ended(TurnStatus::Ok, None, false)), titled).unwrap();
        runtime.publish(None, ask);
        runtime.publish(None, end);
        let kinds = |rx: &mut mpsc::Receiver<Value>| std::iter::from_fn(|| rx.try_recv().ok()).map(|message| {
            assert_eq!(message["method"], "notifications.event");
            message["params"]["kind"].as_str().unwrap().to_string()
        }).collect::<Vec<_>>();
        assert_eq!(kinds(&mut old_rx), ["question", "finished"], "a phone that chose nothing gets everything");
        assert_eq!(kinds(&mut new_rx), ["question"]);

        let all = runtime.missed_notifications(None, 0, None);
        assert_eq!(all.iter().map(|n| n.kind).collect::<Vec<_>>(), [NoticeKind::Question, NoticeKind::Finished]);
        let chosen = filter(json!({ "kinds": ["finished"] }));
        let missed = runtime.missed_notifications(Some(&runtime.notification_epoch), 0, Some(&chosen));
        assert_eq!(missed.iter().map(|n| n.kind).collect::<Vec<_>>(), [NoticeKind::Finished]);
        assert!(runtime.missed_notifications(Some(&runtime.notification_epoch), missed[0].seq, Some(&chosen)).is_empty());
    }

    #[test]
    fn a_subscription_streams_only_what_its_filter_admits_until_it_ends() {
        let sink = crate::sink::BroadcastSink::new(16);
        let runtime = MobileRuntime::new();
        let slot = ConnectionFilter::default();
        let (tx, mut client) = mpsc::channel(16);
        runtime.register_client("phone", tx, Default::default(), slot.clone(), Default::default());
        let streamed = Arc::new(Mutex::new(Vec::new()));
        let heard = streamed.clone();
        let listener = listen_notifications(&sink, &slot, "first", Some(filter(json!({ "kinds": ["question"] }))), move |result| {
            heard.lock().unwrap().push(result["event"]["kind"].as_str().unwrap().to_string());
        });
        let publish = |payload: Payload| {
            let notification = runtime.agent_notification(&event(1, payload), titled).unwrap();
            runtime.publish(Some(&sink), notification);
        };
        let pushed = |client: &mut mpsc::Receiver<Value>| std::iter::from_fn(|| client.try_recv().ok())
            .map(|message| message["params"]["kind"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        publish(asked("q", vec![question("Which?", &["A"], false)]));
        publish(ended(TurnStatus::Ok, None, false));
        assert_eq!(*streamed.lock().unwrap(), ["question"], "the stream is held to the subscription's filter");
        assert_eq!(pushed(&mut client), ["question"], "and so is notifications.event to its connection");

        // A later subscription's filter is not undone by the first one ending.
        let _second = listen_notifications(&sink, &slot, "second", Some(filter(json!({ "kinds": ["finished"] }))), |_| {});
        forget_filter(&slot, "first");
        assert_eq!(slot.lock().unwrap().as_ref().map(|(id, _)| id.as_str()), Some("second"));
        forget_filter(&slot, "second");
        assert!(slot.lock().unwrap().is_none(), "its own subscription ended: the connection's filter is cleared");
        sink.unlisten(listener);
        publish(asked("q2", vec![question("Which?", &["A"], false)]));
        publish(ended(TurnStatus::Ok, None, false));
        assert_eq!(*streamed.lock().unwrap(), ["question"], "nothing more on an ended stream");
        assert_eq!(pushed(&mut client), ["question", "finished"], "no filter: everything, as before filters");
    }

    #[test]
    fn a_pipeline_written_merged_reaches_the_phone_once() {
        let _home = crate::store::temp_home();
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(16));
        let runtime = Arc::new(MobileRuntime::new());
        runtime.configure(sink.clone()).unwrap();
        let (tx, mut client) = mpsc::channel(16);
        runtime.register_client("phone", tx, Default::default(), ConnectionFilter::default(), Default::default());
        let now = Utc::now().to_rfc3339();
        let pipeline = |state: &str, events: Value| json!({
            "id": "p1", "created": now, "modified": now, "projectPath": "/workspace", "branch": "raccoon/7", "author": { "sessionId": "session", "tabId": "tab" },
            "stage": "merge", "state": state, "maxRounds": 3,
            "pr": { "number": 7, "url": "https://github.com/acme/api/pull/7", "base": "main" },
            "issue": { "provider": "github", "id": "7", "identifier": "#7", "title": "Fix login", "url": "https://github.com/acme/api/issues/7" },
            "events": events,
        });
        let merged = json!([{ "at": now, "stage": "merge", "kind": "merged", "message": "TerminalX merged pull request #7." }]);
        let write = |pipeline: Value| sink.emit(crate::issue_pipeline::host::CHANGED, &pipeline);
        write(pipeline("readyToMerge", json!([])));
        write(pipeline("merged", merged.clone()));
        write(pipeline("merged", merged));
        let sent: Vec<Value> = std::iter::from_fn(|| client.try_recv().ok()).filter(|message| message["method"] == "notifications.event").collect();
        assert_eq!(sent.len(), 1, "one notice for one merge, written twice: {sent:?}");
        let notice = &sent[0]["params"];
        assert_eq!((notice["kind"].as_str(), notice["title"].as_str(), notice["body"].as_str()), (Some("pr_merged"), Some("Fix login merged"), Some("TerminalX merged pull request #7.")));
        assert_eq!((notice["sessionId"].as_str(), notice["tabId"].as_str()), (Some("session"), Some("tab")));
        assert_eq!(runtime.missed_notifications(None, 0, None).len(), 1, "kept for a phone that missed it");
    }

    #[test]
    fn a_phone_is_told_this_mac_filters_notices() {
        assert_eq!(capabilities(&current_runtime())["notificationFilters"], 1);
    }

    /// PRO-479: the bots are offered only through a runtime that serves them and
    /// only while Bots is on; their params are closed, and only reads are open
    /// to a phone that cannot drive.
    #[test]
    fn bots_are_offered_only_while_on_and_their_params_are_closed() {
        assert_eq!(capabilities_for(&current_runtime(), true)["bots"], 1);
        assert!(capabilities_for(&current_runtime(), false).get("bots").is_none(), "with Bots off a phone shows nothing of them");
        assert!(capabilities_for(&runtime_of(Some("0.2.22"), None), true).get("bots").is_none(), "an older runtime has no such operation");
        let answer: BotAnswerParams = serde_json::from_value(json!({"id": "b1", "number": 4, "answer": 0, "question": "q1"})).unwrap();
        assert_eq!(answer.into_call(), json!({"operation": "answer", "id": "b1", "number": 4, "answer": 0, "question": "q1"}));
        let typed: BotAnswerParams = serde_json::from_value(json!({"id": "b1", "number": 4, "text": "File it"})).unwrap();
        assert_eq!(typed.into_call(), json!({"operation": "answer", "id": "b1", "number": 4, "text": "File it"}));
        for refused in [json!({"number": 4, "answer": 0}), json!({"id": "b1", "answer": 0}), json!({"id": "b1", "number": 4, "answer": 0, "by": "bot"})] {
            assert!(serde_json::from_value::<BotAnswerParams>(refused.clone()).is_err(), "{refused}");
        }
        assert!(serde_json::from_value::<BotParams>(json!({"id": "b1", "operation": "delete"})).is_err());
    }

    /// PRO-479: a bot's question is sent whatever the session scope says, under the questions a phone chose.
    #[test]
    fn a_bots_question_is_sent_by_kind_and_needs_the_person() {
        let asked = of(NoticeKind::BotQuestion, "home-chat");
        assert!(filter(json!({ "kinds": ["bot_question"], "sessions": { "scope": "only", "ids": ["other"] } })).admits(&asked), "not one session's");
        assert!(!filter(json!({ "kinds": ["question"] })).admits(&asked), "a phone that does not name the kind is not sent it");
        assert!(filter(json!({ "overrides": { "home-chat": "needsMe" } })).admits(&asked));
        assert!(!filter(json!({ "overrides": { "home-chat": "mute" } })).admits(&asked), "the home chat muted mutes its bot's questions");
        assert_eq!(NoticeKind::BotQuestion.name(), "bot_question");
    }

    /// PRO-479: one notice per question asked since the app started, with what the phone answers it by.
    #[test]
    #[cfg_attr(windows, ignore = "Bots are off on Windows")]
    fn each_new_bot_question_is_noticed_once() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let sink = crate::sink::BroadcastSink::new(64);
        let runtime = MobileRuntime::new();
        let bot = crate::bots::chat::hire(&sink, "cto", "Atlas").unwrap();
        let new = crate::bots::items::NewItem { title: "Move macOS CI".into(), summary: String::new(), done_means: Vec::new(), start: true, asked_by: None, added_by: None };
        crate::bots::items::add(&sink, &bot, &crate::bots::items::By::Bot { session: None }, new).unwrap();
        assert!(runtime.bot_notifications(&bot.id).is_empty(), "nothing asked");
        let item = crate::bots::items::ask(&sink, &bot, 1, "Approve the plan and start the run?", &["Approve and start".into(), "Not now".into()], Some(0)).unwrap();
        let notices = runtime.bot_notifications(&bot.id);
        assert_eq!(notices.len(), 1);
        let notice = &notices[0];
        assert_eq!((notice.kind, notice.title.as_str(), notice.body.as_str()), (NoticeKind::BotQuestion, "Atlas asks", "Approve the plan and start the run?"));
        let (home, tab) = crate::bots::phone::home_chat_of(&bot.id).unwrap();
        assert_eq!((notice.session_id.as_deref(), notice.tab_id.as_deref()), (Some(home.as_str()), Some(tab.as_str())), "an older phone opens the chat it came from");
        assert_eq!(notice.bot_question, Some(BotQuestionNotice {
            bot_id: bot.id.clone(), number: 1, question: item.question.unwrap().id,
            answers: vec!["Approve and start".into(), "Not now".into()], recommended: Some(0),
        }));
        let wire = serde_json::to_value(notice).unwrap();
        assert_eq!((wire["kind"].as_str(), wire["botQuestion"]["botId"].as_str()), (Some("bot_question"), Some(bot.id.as_str())));
        assert!(runtime.bot_notifications(&bot.id).is_empty(), "noticed once");
        // A question asked again is news again.
        crate::bots::items::ask(&sink, &bot, 1, "Start, but ask before merging?", &["Yes".into(), "No".into()], None).unwrap();
        assert_eq!(runtime.bot_notifications(&bot.id).len(), 1);
        // With Bots off, nothing.
        crate::bots::items::ask(&sink, &bot, 1, "Third time?", &["Yes".into(), "No".into()], None).unwrap();
        settings.experimental.bots = false;
        crate::store::settings::save(&settings).unwrap();
        assert!(runtime.bot_notifications(&bot.id).is_empty());
    }

    /// PRO-479: phones read their capabilities again when Bots is switched, and only then.
    #[test]
    fn switching_bots_tells_phones_to_ask_again() {
        let runtime = MobileRuntime::new();
        let (sender, _receiver) = mpsc::channel(4);
        let invalidations = Arc::new(super::super::Invalidations::default());
        runtime.register_client("c", sender, Arc::default(), Arc::default(), invalidations.clone());
        let was = runtime.bots_on.load(std::sync::atomic::Ordering::SeqCst);
        runtime.watch_bots_switch(was);
        assert!(invalidations.take().is_empty(), "no change, nothing to ask");
        runtime.watch_bots_switch(!was);
        assert_eq!(invalidations.take(), vec![json!({ "method": "sync.capabilitiesChanged" })]);
        runtime.invalidate(super::super::Invalidation::Bots);
        assert_eq!(invalidations.take(), vec![json!({ "method": "bots.changed" })]);
    }
}
