//! Tabs follow their terminal (#437).
//!
//! A tab used to be what it was created as: an agent tab stayed that agent's
//! for life, and a shell stayed a shell whatever was typed into it. Now a tab
//! is whatever its terminal has in front. Three things can be there, and
//! `Front` in the session index names them:
//!
//! - the tab's agent, launched by the app (`Agent`): what `session.rs` has
//!   always run, with the app's hooks and settings;
//! - the tab's agent, started by hand in the tab's terminal (`ByHand`): the
//!   reader typed `claude` or `codex` into a shell. The app did not launch
//!   it, so it has none of the app's hooks. It is followed instead: the
//!   conversation it writes is found (`Locator`) and tailed from its start,
//!   and prompts sent from the chat are typed into it like any other;
//! - no agent (`Terminal`): a shell.
//!
//! The foreground watcher (`crate::foreground`) says when an agent comes to
//! the front of a pane or leaves it, and a pane's exit says when the app's
//! own CLI has gone. Either way the tab keeps its id, its place and its log;
//! only what it is changes.
//!
//! A shell tab has no entry in the index until an agent is first started in
//! it. It is then given one that takes the shell's pane over (`Follow::pane`)
//! and its place among the session's tabs, and from then on it is a tab like
//! any other.
//!
//! One tab can hold several conversations over its life, one after another:
//! Claude Code exited and Codex started, or the same agent started again on
//! something new. They share the tab's log, each under its own marker
//! (`Payload::Conversation`), and the ones before the current are listed in
//! `Follow::history`. An agent started on a conversation the tab already
//! holds picks that one up instead of opening another.
//!
//! Only the desktop app follows terminals (`SessionManager::follow_terminals`).
//! A cloud workspace's runtime does not call it, and behaves as it always did.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use super::*;
use crate::foreground::Agent;
use crate::store::index::Front;

/// The permission mode of an agent the app did not launch, until the agent
/// says what it is in: not one the app chose, and not one it may assume.
pub const MODE_SET_IN_TERMINAL: &str = "terminal";
/// The mode such a conversation is in once the app launches it itself (a
/// resume, or the tab opened after a restart): the one that asks. It is then
/// a mode like any other, shown in the picker and changed from it.
pub const MODE_WHEN_RESUMED: &str = "manual";

/// The app's own reason for not typing a prompt into a tab's terminal: the
/// CLI it was for has left it, or the reader is running something there.
/// Nothing happened to an agent, so nothing is raised in the tab for it, and
/// the reason is the app's own words, said to the sender as written.
#[derive(Debug)]
pub struct Refusal(pub String);

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refusal {}

/// How often a CLI started by hand is asked which conversation it is in,
/// where asking costs something: often until its transcript is known, then
/// now and again, since the reader may clear or switch the conversation
/// from inside the CLI.
pub const LOCATE_UNKNOWN: Duration = Duration::from_secs(1);
pub const LOCATE_KNOWN: Duration = Duration::from_secs(3);
/// How many records of a conversation's history are brought in at a time
/// with the tab's lock held, so a long one does not keep the tab from
/// answering anything else until it is all in.
const IMPORT_BATCH: usize = 200;
/// How long before the app first saw a CLI its transcript may have been made
/// and still be the one that CLI is writing now, rather than an older
/// conversation it was started on. The CLI is seen within a moment of
/// starting and writes nothing before its first prompt; this only allows for
/// the two clocks' grain.
const SEEN_SLACK: Duration = Duration::from_secs(2);
/// How long a CLI has to have said it is idle, with nothing new in its
/// transcript, before the turn the app has open is closed.
///
/// The CLI says it is idle a moment before it writes down what it last said
/// (measured: its word is on disk within a tenth of a second of the turn's
/// end, the reply's record after it). Closing on the word alone put the reply
/// outside its own turn, drawn under the "Worked for" line. And a CLI is busy
/// within a tenth of a second of taking a prompt, so one that has been idle
/// this long is done even if the app never caught it busy: a turn quicker
/// than the app looks.
const IDLE_SETTLE: Duration = Duration::from_millis(800);

/// The conversation a CLI started by hand is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    /// The agent's own id for it.
    pub provider_session_id: String,
    /// The file the CLI writes it to, once that is known. The file itself
    /// may not exist yet: neither CLI writes one before the first prompt.
    pub transcript: Option<PathBuf>,
}

/// What a CLI started by hand says it is doing, where it says at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Idle,
    Busy,
    /// Stopped on a question only the reader can answer, in its own screen.
    Waiting,
}

/// What a CLI started by hand says of itself that costs next to nothing to
/// read, where it says anything.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Glance {
    /// The id of the conversation it is in. One that is not the id it was
    /// last found under is a reason to find it again at once.
    pub conversation: Option<String>,
    pub activity: Option<Activity>,
}

/// Finds the conversation of a CLI the app did not launch. Each harness
/// answers in its own way (`harness::by_hand`); a test answers as it likes.
pub trait Locator: Send + Sync {
    /// Which conversation it is in, and where that is written. This may cost
    /// something (a folder listed, the process's open files), so it is asked
    /// every `locate_every`, or when a glance says the conversation changed.
    fn locate(&self, agent: &Agent) -> Option<Located>;
    /// Asked on every look, five times a second for as long as the CLI
    /// runs: one small read at most.
    fn glance(&self, _agent: &Agent) -> Glance {
        Glance::default()
    }
    /// How long to leave between two `locate`s of the same CLI. `settled` is
    /// whether its transcript is on disk.
    fn locate_every(&self, _agent: &Agent, settled: bool) -> Duration {
        if settled {
            LOCATE_KNOWN
        } else {
            LOCATE_UNKNOWN
        }
    }
    /// Whether `locate` is cheap enough for the thread that watches every
    /// pane, so the tab can be on the right conversation the moment the CLI
    /// is seen.
    fn at_once(&self, _agent: &Agent) -> bool {
        false
    }
}

/// What following terminals needs to remember beside the tabs themselves.
pub struct Following {
    enabled: AtomicBool,
    /// The app is going down: panes exiting now are its own doing.
    closing: AtomicBool,
    locator: Mutex<Arc<dyn Locator>>,
    /// The agent in front of each pane right now, whichever it is.
    fronts: Mutex<HashMap<String, Agent>>,
}

impl Default for Following {
    fn default() -> Self {
        Self { enabled: AtomicBool::new(false), closing: AtomicBool::new(false), locator: Mutex::new(Arc::new(crate::harness::by_hand::Installed::default())), fronts: Mutex::default() }
    }
}

impl Following {
    fn locator(&self) -> Arc<dyn Locator> {
        self.locator.lock().unwrap().clone()
    }
}

/// A CLI the reader started by hand, as the tab that follows it holds it.
pub struct ByHand {
    pub agent: Agent,
    /// The conversation it was last found in.
    located: Option<Located>,
    activity: Option<Activity>,
    /// Since when it has said it is idle, without a break.
    idle_since: Option<Instant>,
    /// When the app first saw it. A transcript made after this is one it is
    /// writing now; an older one is a conversation it was started on.
    seen_at: SystemTime,
    /// When it was last asked which conversation it is in, if it has been.
    looked: Option<Instant>,
    /// A conversation it named that the tab's log holds nothing of, until
    /// its transcript is first read. A CLI may name its conversation before
    /// it says where that is written (Codex takes its lock first), and by
    /// then the tab is on that conversation by name alone.
    unread: Option<String>,
    /// Set when the tail has just been pointed at a transcript that may
    /// already hold turns: the next read of it sorts history from what is
    /// happening now.
    first: Option<First>,
}

/// What a transcript holds when it is first read for a tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum First {
    /// An older conversation the CLI was started on: all of it is history.
    History,
    /// One the CLI is writing now. It is nearly always just the prompt that
    /// made it; a fork arrives holding a copy of its parent's turns, and
    /// those are history up to the prompt it is on.
    Live,
}

/// The agent in front of a pane, for a window to draw the pane's tab with.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneAgent {
    pub pane_id: String,
    /// The harness id, or nothing once the agent has left.
    pub harness: Option<String>,
}

pub const PANE_AGENT_EVENT: &str = "pane_agent";

/// How an agent left the front of its tab's terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gone {
    Exited,
    /// Still running, but no longer the job in front (Ctrl+Z).
    Suspended,
    /// Another agent was started over it.
    Replaced,
}

/// What became of the tab's conversation when an agent was matched to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Settled {
    /// The tab's log already holds this conversation's earlier turns.
    known: bool,
}

fn decoders(kind: CliKind) -> (tui::Decoder, tui::Marker) {
    match kind {
        CliKind::Claude => (claude::transcript::decode_line, claude::transcript::decode_marked),
        CliKind::Codex => (codex::rollout::decode_line, codex::rollout::decode_marked),
    }
}

/// Whether nothing was ever said in one of a tab's conversations, going by
/// the tab's log. `conversation` is the marker its events come under, absent
/// for the conversation the tab began with.
pub(crate) fn conversation_is_blank(log: &Path, conversation: Option<&str>) -> bool {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(log) else { return true };
    let mut under: Option<String> = None;
    for line in std::io::BufReader::new(file).lines().map_while(std::result::Result::ok) {
        // Most of a log is neither: only these two kinds are parsed.
        let marker = line.contains(r#""type":"conversation""#);
        if !marker && !line.contains(r#""type":"user_message""#) {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        match event["payload"]["type"].as_str() {
            Some("conversation") => under = event["payload"]["id"].as_str().map(String::from),
            Some("user_message") if under.as_deref() == conversation => return false,
            _ => {}
        }
    }
    true
}

impl SessionManager {
    /// Follow what runs in every tab's terminal from now on. Called once, by
    /// the desktop app.
    pub fn follow_terminals(&self) {
        if self.follow.enabled.swap(true, Ordering::SeqCst) {
            return;
        }
        let manager = self.clone();
        crate::foreground::Watch::start(self.terminals.clone(), move |pane, agent| manager.pane_foreground(pane, agent.cloned()));
    }

    pub(crate) fn follows(&self) -> bool {
        self.follow.enabled.load(Ordering::SeqCst)
    }

    /// The app is quitting: the panes that exit from here on were closed by
    /// it, and no tab is to be turned into a terminal for that.
    pub(crate) fn closing(&self) {
        self.follow.closing.store(true, Ordering::SeqCst);
    }

    /// The agents in front of panes right now, for a window that loads after
    /// they were started.
    pub fn pane_agents(&self) -> Vec<PaneAgent> {
        self.follow.fronts.lock().unwrap().iter().map(|(pane, agent)| PaneAgent { pane_id: pane.clone(), harness: Some(agent.harness.to_string()) }).collect()
    }

    /// The watcher's word: `agent` is in front of `pane` now, or the agent
    /// that was has left. Every harness in the registry is reported to the
    /// window, so the pane's tab is drawn as that agent's. The ones whose
    /// conversation the app can project (`pty_first`) also become the tab's
    /// agent, with a chat.
    pub fn pane_foreground(&self, pane: &str, agent: Option<Agent>) {
        if !self.follows() {
            return;
        }
        {
            let mut fronts = self.follow.fronts.lock().unwrap();
            match &agent {
                Some(agent) => fronts.insert(pane.to_string(), agent.clone()),
                None => fronts.remove(pane),
            };
        }
        self.sink.emit(PANE_AGENT_EVENT, &PaneAgent { pane_id: pane.to_string(), harness: agent.as_ref().map(|agent| agent.harness.to_string()) });
        let outcome = match agent {
            Some(agent) if pty_first(agent.harness).is_some() => self.agent_came(pane, agent),
            Some(_) => Ok(()),
            None => {
                self.agent_left(pane);
                Ok(())
            }
        };
        if let Err(error) = outcome {
            log::warn!("follow the agent in {pane}: {error:#}");
        }
    }

    /// The tab that lives in `pane`, with its session.
    pub(crate) fn tab_of_pane(&self, pane: &str) -> Option<(index::SessionEntry, TabEntry)> {
        index::load().ok()?.into_iter().find_map(|session| {
            let tab = session.tabs.iter().find(|tab| tab.pane_id() == pane)?.clone();
            Some((session, tab))
        })
    }

    fn agent_came(&self, pane: &str, agent: Agent) -> Result<()> {
        let (entry, tab) = match self.tab_of_pane(pane) {
            Some(found) => found,
            None => match self.adopt_shell(pane, &agent)? {
                Some(made) => made,
                // Not a session's shell: there is no tab for it to become.
                None => return Ok(()),
            },
        };
        self.attach(&entry.id, &tab.id, pane, agent)
    }

    /// Give a shell tab an entry of its own, now that an agent runs in it:
    /// in the shell's pane, in the shell's place among the session's tabs,
    /// under the name the reader gave the shell if they gave it one.
    fn adopt_shell(&self, pane: &str, agent: &Agent) -> Result<Option<(index::SessionEntry, TabEntry)>> {
        let Some(session_id) = pty::shell_session(pane) else { return Ok(None) };
        if index::get(session_id).is_err() {
            return Ok(None);
        }
        let Some((_, created)) = self.terminals.opened(pane) else { return Ok(None) };
        let (title, renamed) = self.terminals.title(pane).unwrap_or_else(|| ("Terminal".into(), false));
        let tab = TabEntry {
            created,
            title: renamed.then(|| title.clone()),
            permission_mode: MODE_SET_IN_TERMINAL.into(),
            follow: index::Follow { pane: Some(pane.to_string()), terminal_title: Some(title), title_pinned: renamed, adopted: true, ..Default::default() },
            ..crate::session_ops::new_tab_entry(&crate::session_ops::NewTab { harness: agent.harness.to_string(), model: String::new(), effort: None, permission_mode: None })
        };
        let made = tab.clone();
        // The session's active tab is left alone: a window on another tab
        // stays on it, and one on this shell is on this tab already.
        let entry = index::update_session(session_id, |session| {
            session.tabs.push(tab);
            Ok(session.clone())
        })?;
        // The place the reader gave the shell in its workspace's row, with
        // its pin, mute and title, is the tab's (#438). The session first:
        // a window is told of the tab before it is told where the tab goes.
        if index::shell_became_tab(pane, &made.id).unwrap_or(false) {
            self.sink.emit("session_updated", &entry);
            if let Ok(tabs) = index::tab_state() {
                self.sink.emit("tab_state_changed", &tabs);
            }
        }
        Ok(Some((entry, made)))
    }

    /// Take a CLI the reader started by hand as the tab's agent.
    fn attach(&self, session_id: &str, tab_id: &str, pane: &str, agent: Agent) -> Result<()> {
        let Some(kind) = pty_first(agent.harness) else { return Ok(()) };
        let rt_arc = self.runtime(session_id, tab_id)?;
        let locator = self.follow.locator();
        // This is the watcher's thread, which every pane waits on: a CLI is
        // only asked here when asking is a file read. One whose answer takes
        // listing its open files is asked by the thread that follows it, a
        // moment from now.
        let asked = locator.at_once(&agent);
        let found = asked.then(|| locator.locate(&agent)).flatten();
        let mut rt = rt_arc.lock().unwrap();
        if rt.stopping {
            return Ok(());
        }
        match &rt.engine {
            Engine::Cli(p) if p.by_hand.as_ref().is_some_and(|by| by.agent.pid == agent.pid) => return Ok(()),
            // The app's own CLI has this pane, and what it puts in front of
            // itself is its business.
            Engine::Cli(p) if p.by_hand.is_none() && self.terminals.is_running(&p.pane_id) => return Ok(()),
            // A headless tab's hand-off terminal.
            Engine::Acp(_) | Engine::OpenCode(_) => return Ok(()),
            Engine::Cli(_) => self.became_terminal(&mut rt, Gone::Replaced),
            Engine::None => {}
        }
        let seen_at = SystemTime::now();
        let settled = self.settle_conversation(&mut rt, agent.harness, found.as_ref(), true)?;
        let (decode, marker) = decoders(kind);
        let reading = found.as_ref().and_then(|at| Self::reading_from(&rt, at, settled, seen_at));
        // Named, with nowhere to read it yet and nothing of it in the log.
        let unread = found.as_ref().filter(|_| reading.is_none() && !settled.known).map(|at| at.provider_session_id.clone());
        let (tail, first) = match reading {
            Some((path, offset, first)) => (tui::Tail::from_offset(path, offset, decode), first),
            None => (tui::Tail::unknown(decode), None),
        };
        let tail = Arc::new(tail.marking(marker));
        let generation = self.starts.fetch_add(1, Ordering::Relaxed);
        // It has the terminal raw, which is how it was noticed: it is up.
        let ready = Arc::new(tui::Ready::new(false));
        ready.mark();
        let mode = index::get(session_id)?.tab(tab_id).map(|tab| tab.permission_mode.clone()).unwrap_or_default();
        rt.restart_claim = None;
        rt.stopping_pid = None;
        rt.engine = Engine::Cli(CliTab {
            usage_account: None,
            harness: kind,
            mode,
            pane_id: pane.to_string(),
            nudge_by: None,
            held: Vec::new(),
            resend_after_abort: None,
            codex_interrupt_hooks_owed: 0,
            codex_prompt_starts_turn: false,
            generation,
            restart_when_idle: false,
            settings_asked_at: None,
            launched_for: None,
            status_names_model: false,
            settings_command_is_ours: false,
            ready,
            tail: tail.clone(),
            echoed: Default::default(),
            awaiting_delivery: None,
            delivery_sent_at: None,
            accept_by: None,
            decisions: HashMap::new(),
            turn_tail: Default::default(),
            transcript_turn: None,
            transcript_end_owed: false,
            answered: HashMap::new(),
            command: format!("{} (started in this terminal)", crate::harness::display_name(agent.harness)),
            // No hook of the app's was given to this CLI, so no frame can be
            // its: the token is one nobody holds, and no path is under the root.
            origin: Origin { token: crate::hooks::mint_token(), transcript_root: store::root()?.join("run").join("no-hooks"), conversation: None },
            by_hand: Some(Box::new(ByHand { agent, located: found, activity: None, idle_since: None, seen_at, looked: asked.then(Instant::now), unread, first })),
        });
        rt.turn_open = false;
        rt.left_at = None;
        self.set_front(&rt, Front::ByHand);
        self.announce_pane(&rt);
        self.announce_tab(&rt);
        drop(rt);
        // What the transcript already holds is read by the thread that
        // follows it, not here: this is the watcher's, and a long
        // conversation would keep every other pane waiting.
        self.follow_transcript(&rt_arc, tail, pane.to_string(), generation);
        Ok(())
    }

    /// The transcript to read, where to start, and how to take what it
    /// already holds. `None` while the CLI has yet to say where it writes.
    ///
    /// - A file the tab was following when it last let go is read on from
    ///   where it had got to.
    /// - A file that does not exist yet, or was made since this CLI was first
    ///   seen, is the one it is writing now: read from its start. A fork is
    ///   made that way too, and arrives holding its parent's turns, which
    ///   the first read sets apart (`First::Live`).
    /// - An older file is a conversation the CLI was started on. If it is one
    ///   the tab holds, what it has in it is in the log from before, and only
    ///   what is added counts. If the tab has never seen it, all of it is
    ///   brought in, so the chat shows the conversation from its first turn.
    fn reading_from(rt: &TabRuntime, at: &Located, settled: Settled, seen_at: SystemTime) -> Option<(PathBuf, u64, Option<First>)> {
        let path = at.transcript.clone()?;
        let meta = std::fs::metadata(&path).ok();
        let len = meta.as_ref().map_or(0, |meta| meta.len());
        if let Some((_, offset)) = rt.left_at.as_ref().filter(|(left, offset)| *left == path && *offset <= len) {
            return Some((path, *offset, None));
        }
        // The earlier of when it was made and when it was last written: a
        // file copied in with its dates kept is as old as what is in it, and
        // so is one on a disk that does not say when a file was made.
        let made = meta.and_then(|meta| {
            let written = meta.modified().ok()?;
            Some(meta.created().map_or(written, |made| made.min(written)))
        });
        if made.is_none_or(|made| made + SEEN_SLACK >= seen_at) {
            return Some((path, 0, Some(First::Live)));
        }
        Some(if settled.known { (path, len, None) } else { (path, 0, (len > 0).then_some(First::History)) })
    }

    /// Match the tab's conversation to the one an agent in its terminal is
    /// in. The same one carries on. One the tab held before is picked up
    /// again. Anything else is a new conversation: what the tab held goes to
    /// its history, unless nothing was ever said in it.
    ///
    /// `arrived` is true when a process has just come to the front. Both
    /// CLIs name their conversation within a moment of starting, so one that
    /// has not yet is waited for when it is the tab's own agent: the tab's
    /// conversation stands until the CLI says otherwise. A different agent
    /// cannot be on the tab's conversation whatever it turns out to be on,
    /// and starts a new one at once.
    fn settle_conversation(&self, rt: &mut TabRuntime, harness: &str, found: Option<&Located>, arrived: bool) -> Result<Settled> {
        let entry = index::get(&rt.session_id)?;
        let tab = entry.tab(&rt.tab_id).ok_or_else(|| anyhow!("tab {} not found", rt.tab_id))?;
        let same_agent = tab.harness == harness;
        let id = found.map(|at| at.provider_session_id.as_str());
        if same_agent && id.is_some() && tab.provider_session_id.as_deref() == id {
            return Ok(Settled { known: true });
        }
        let past = id.and_then(|id| tab.follow.history.iter().position(|past| past.harness == harness && past.provider_session_id.as_deref() == Some(id)));
        // The tab's conversation has no name yet, and this is it: a tab made
        // for this agent that never ran, or a CLI that names its conversation
        // only once something has been said.
        if same_agent && tab.provider_session_id.is_none() && past.is_none() {
            if let Some(id) = id {
                index::update_tab(&rt.session_id, &rt.tab_id, |tab| {
                    tab.provider_session_id = Some(id.to_string());
                    // Started by hand, whoever made the tab.
                    tab.follow.adopted = true;
                    Ok(())
                })?;
            }
            return Ok(Settled { known: false });
        }
        if id.is_none() && (same_agent || !arrived) {
            return Ok(Settled { known: false });
        }
        let blank = conversation_is_blank(&rt.log_path, tab.follow.conversation.as_deref());
        let fresh = uuid::Uuid::now_v7().to_string();
        let (conversation, resumed) = index::update_tab(&rt.session_id, &rt.tab_id, |tab| {
            let leaving = tab.past();
            let back = past.filter(|at| *at < tab.follow.history.len()).map(|at| tab.follow.history.remove(at));
            if !blank {
                tab.follow.history.push(leaving);
            }
            let resumed = back.is_some();
            match back {
                Some(back) => {
                    tab.harness = back.harness;
                    tab.provider_session_id = back.provider_session_id;
                    tab.model = back.model;
                    tab.effort = back.effort;
                    tab.permission_mode = back.permission_mode;
                    tab.context_used = back.context_used;
                    tab.context_max = back.context_max;
                    tab.follow.conversation = back.id;
                    tab.follow.adopted = back.adopted;
                    if !tab.follow.title_pinned {
                        tab.title = back.title;
                    }
                }
                None => {
                    tab.harness = harness.to_string();
                    tab.provider_session_id = id.map(String::from);
                    tab.model = String::new();
                    tab.effort = None;
                    tab.permission_mode = MODE_SET_IN_TERMINAL.into();
                    tab.context_used = None;
                    tab.context_max = None;
                    tab.follow.conversation = Some(fresh);
                    tab.follow.adopted = true;
                    if !tab.follow.title_pinned {
                        tab.title = None;
                    }
                }
            }
            tab.requested_model = None;
            tab.requested_effort = None;
            tab.requested_permission_mode = None;
            tab.fork_from = None;
            Ok((tab.follow.conversation.clone(), resumed))
        })?;
        rt.harness = harness.to_string();
        rt.last_settings_report = None;
        self.publish(rt, Payload::Conversation { id: conversation, harness: harness.to_string(), resumed }, None);
        Ok(Settled { known: resumed })
    }

    /// Read the transcript of a CLI the reader started by hand: each record
    /// as it stands, since its word that a turn ended is what ends the turn.
    ///
    /// The first read of a transcript that already held something sorts what
    /// is history from what is happening now.
    pub(super) fn pump_by_hand(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>) {
        self.pump_by_hand_from(rt_arc, tail, || tail.drain_records());
    }

    pub(super) fn pump_by_hand_from(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &Arc<tui::Tail>, read: impl FnOnce() -> Vec<tui::Record>) {
        let (first, agent) = match &mut rt_arc.lock().unwrap().engine {
            Engine::Cli(CliTab { tail: current, by_hand: Some(by), .. }) if Arc::ptr_eq(current, tail) => (by.first.take(), by.agent.clone()),
            _ => return,
        };
        let mut records = read();
        let prompts: Vec<usize> =
            records.iter().enumerate().filter(|(_, (payloads, _, _))| payloads.iter().any(|payload| matches!(payload, Payload::UserMessage { .. }))).map(|(at, _)| at).collect();
        // Still the first read until there is something to sort.
        let wait = |first: First| {
            if let Engine::Cli(CliTab { tail: current, by_hand: Some(by), .. }) = &mut rt_arc.lock().unwrap().engine {
                if Arc::ptr_eq(current, tail) { by.first.get_or_insert(first); }
            }
        };
        let history = match first {
            None => 0,
            Some(first) if records.is_empty() => return wait(first),
            Some(First::History) => records.len(),
            // A conversation being written now starts with the prompt that
            // made it. One that arrives holding several prompts was handed
            // its history (a fork): everything before the prompt it is on.
            Some(First::Live) => match prompts.as_slice() {
                [] => {
                    wait(First::Live);
                    0
                }
                [.., last] => *last * usize::from(prompts.len() > 1),
            },
        };
        let live = records.split_off(history);
        if !records.is_empty() {
            let busy = live.is_empty() && self.follow.locator().glance(&agent).activity == Some(Activity::Busy);
            self.import(rt_arc, tail, records, live.is_empty(), busy);
        }
        for (payloads, mark, ts) in live {
            self.pump_read(rt_arc, tail, vec![(payloads, mark, ts)]);
        }
    }

    /// Bring a conversation's history into the tab's log, as turns that are
    /// over. Nothing here is work happening, so no status moves and nobody
    /// is notified. `whole` is whether this is all the transcript holds: a
    /// last turn left open is then one the CLI is still on (`busy`) or one
    /// that was cut short; otherwise the prompt that follows closes it.
    ///
    /// The tab's lock is taken a batch at a time, so a long conversation
    /// does not keep the tab from answering anything else until it is in.
    fn import(&self, rt_arc: &Arc<Mutex<TabRuntime>>, tail: &tui::Tail, records: Vec<tui::Record>, whole: bool, busy: bool) {
        let ended = |status| Payload::TurnCompleted { status, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false };
        let mut open = false;
        let mut records = records.into_iter().peekable();
        while records.peek().is_some() {
            let mut rt = rt_arc.lock().unwrap();
            if !Self::has_tail(&rt, tail) || !matches!(&rt.engine, Engine::Cli(p) if p.by_hand.is_some()) {
                return;
            }
            for (payloads, mark, ts) in records.by_ref().take(IMPORT_BATCH) {
                rt.source_timestamp = Some(ts);
                for payload in payloads {
                    match payload {
                        Payload::ProviderSettings { signal } => self.provider_settings(&mut rt, signal),
                        // A turn the CLI started itself (#540) is a turn of
                        // the history like any prompted one.
                        Payload::UserMessage { .. } | Payload::TurnStarted { started_by: Some(_), .. } => {
                            if open {
                                self.publish(&mut rt, ended(TurnStatus::Ok), None);
                            }
                            self.publish(&mut rt, payload, None);
                            open = true;
                        }
                        // An interruption closes the turn it interrupted, once.
                        Payload::TurnCompleted { .. } => {
                            if open {
                                self.publish(&mut rt, payload, None);
                                open = false;
                            }
                        }
                        other => {
                            if let Payload::UsageUpdate(Usage { model: Some(model), .. }) = &other {
                                self.provider_settings(&mut rt, Signal::Current { model: Some(model.clone()), effort: None });
                            }
                            self.publish(&mut rt, other, None);
                        }
                    }
                }
                if let (Some(mark), true) = (mark.filter(|mark| mark.ends()), open) {
                    self.publish(&mut rt, ended(if mark == tui::TurnMark::Aborted { TurnStatus::Aborted } else { TurnStatus::Ok }), None);
                    open = false;
                }
                rt.source_timestamp = None;
            }
        }
        if !open {
            return;
        }
        let mut rt = rt_arc.lock().unwrap();
        if !Self::has_tail(&rt, tail) || !matches!(&rt.engine, Engine::Cli(p) if p.by_hand.is_some()) {
            return;
        }
        if !whole {
            self.publish(&mut rt, ended(TurnStatus::Ok), None);
        } else if busy {
            rt.open_turn();
            rt.turn_started_at = Some(Instant::now());
            if let Engine::Cli(p) = &mut rt.engine {
                p.turn_tail.opened();
            }
            self.set_status(&mut rt, TabStatus::InProgress);
        } else {
            self.publish(&mut rt, ended(TurnStatus::Aborted), None);
        }
    }

    /// One look at a CLI started by hand, from the thread that tails its
    /// transcript: is it still in the conversation it was in, and what does
    /// it say it is doing.
    pub(super) fn follow_by_hand(&self, rt_arc: &Arc<Mutex<TabRuntime>>) {
        let (agent, located, looked) = match &rt_arc.lock().unwrap().engine {
            Engine::Cli(CliTab { by_hand: Some(by), .. }) => (by.agent.clone(), by.located.clone(), by.looked),
            _ => return,
        };
        let locator = self.follow.locator();
        let Glance { conversation, activity } = locator.glance(&agent);
        // Finding it again is for when something may have changed: it says
        // it is in another conversation, or it has been a while.
        let renamed = conversation.is_some() && conversation.as_deref() != located.as_ref().map(|at| at.provider_session_id.as_str());
        let settled = located.as_ref().and_then(|at| at.transcript.as_deref()).is_some_and(Path::exists);
        let due = renamed || looked.is_none_or(|looked| looked.elapsed() >= locator.locate_every(&agent, settled));
        // A CLI between conversations names none for a moment: the last one
        // found stands until another is.
        let moved = due.then(|| locator.locate(&agent)).flatten().filter(|found| Some(found) != located.as_ref());
        let mut rt = rt_arc.lock().unwrap();
        let (before, idle_for) = match &mut rt.engine {
            Engine::Cli(CliTab { by_hand: Some(by), .. }) if by.agent.pid == agent.pid => {
                if due {
                    by.looked = Some(Instant::now());
                }
                by.idle_since = (activity == Some(Activity::Idle)).then(|| by.idle_since.unwrap_or_else(Instant::now));
                (std::mem::replace(&mut by.activity, activity), by.idle_since.map_or(Duration::ZERO, |since| since.elapsed()))
            }
            _ => return,
        };
        if let Some(found) = moved {
            if let Err(error) = self.moved_conversation(&mut rt, &agent, found) {
                log::warn!("follow {}/{} to another conversation: {error:#}", rt.session_id, rt.tab_id);
            }
        }
        let prompt_owed = matches!(&rt.engine, Engine::Cli(p) if p.awaiting_delivery.is_some());
        // Nothing has come from the transcript for as long as it has been idle.
        let quiet = rt.last_activity.elapsed() >= IDLE_SETTLE;
        match (before, activity) {
            (was, Some(Activity::Busy)) if was != Some(Activity::Busy) => {
                if !rt.turn_open {
                    rt.open_turn();
                    rt.turn_started_at = Some(Instant::now());
                    if let Engine::Cli(p) = &mut rt.engine {
                        p.turn_tail.opened();
                    }
                }
                if rt.pending.is_empty() {
                    self.set_status(&mut rt, TabStatus::InProgress);
                }
            }
            // It is asking in its own screen. Nothing has gone wrong, so this
            // is the status alone and no recovery.
            (was, Some(Activity::Waiting)) if was != Some(Activity::Waiting) && rt.turn_open => self.set_display_status(&mut rt, TabStatus::Waiting),
            // Done, once its word has stood a moment and its transcript has
            // caught up with it. A prompt the chat has typed and the CLI has
            // not taken yet is not a turn that has ended.
            (_, Some(Activity::Idle)) if rt.turn_open && !prompt_owed && quiet && idle_for >= IDLE_SETTLE => {
                let tail = match &rt.engine {
                    Engine::Cli(p) => p.tail.clone(),
                    _ => return,
                };
                drop(rt);
                self.pump(rt_arc, &tail);
                let mut rt = rt_arc.lock().unwrap();
                if !rt.turn_open || !matches!(&rt.engine, Engine::Cli(CliTab { by_hand: Some(by), .. }) if by.agent.pid == agent.pid) {
                    return;
                }
                let said = match &rt.engine {
                    Engine::Cli(p) => p.turn_tail.last_assistant_message().map(str::to_owned),
                    _ => None,
                };
                self.end_open_turn(&mut rt, TurnStatus::Ok, None);
                self.after_turn_completed(rt_arc, rt, said);
            }
            _ => {}
        }
    }

    /// The CLI is in another conversation than the one it was found in: it
    /// was cleared, switched from inside, or has only now named the one it
    /// started or said where it writes it.
    fn moved_conversation(&self, rt: &mut TabRuntime, agent: &Agent, found: Located) -> Result<()> {
        let (seen_at, unread) = match &rt.engine {
            Engine::Cli(CliTab { by_hand: Some(by), .. }) => (by.seen_at, by.unread.clone()),
            _ => return Ok(()),
        };
        let settled = self.settle_conversation(rt, agent.harness, Some(&found), false)?;
        // On it by name, and the log still has nothing of it: not known yet.
        let settled = Settled { known: settled.known && unread.as_deref() != Some(found.provider_session_id.as_str()) };
        let reading = Self::reading_from(rt, &found, settled, seen_at);
        if let Engine::Cli(p) = &mut rt.engine {
            let first = match &reading {
                Some((path, offset, first)) => {
                    p.tail.follow(path, *offset);
                    *first
                }
                None => None,
            };
            if let Some(by) = &mut p.by_hand {
                by.unread = (reading.is_none() && !settled.known).then(|| found.provider_session_id.clone());
                by.first = first;
                by.located = Some(found);
            }
        }
        self.announce_tab(rt);
        Ok(())
    }

    /// The agent that was in front of `pane` no longer is: it exited, or was
    /// suspended. A tab that was following it is a terminal again.
    fn agent_left(&self, pane: &str) {
        let Some((entry, tab)) = self.tab_of_pane(pane) else { return };
        let Ok(rt_arc) = self.runtime(&entry.id, &tab.id) else { return };
        let tail = match &rt_arc.lock().unwrap().engine {
            Engine::Cli(p) if p.by_hand.is_some() => p.tail.clone(),
            _ => return,
        };
        // Its last words first.
        self.pump(&rt_arc, &tail);
        let mut rt = rt_arc.lock().unwrap();
        let alive = match &rt.engine {
            Engine::Cli(CliTab { by_hand: Some(by), .. }) => crate::harness::host::is_alive(by.agent.pid),
            _ => return,
        };
        let turn_was_open = rt.turn_open;
        self.became_terminal(&mut rt, if alive { Gone::Suspended } else { Gone::Exited });
        drop(rt);
        if turn_was_open {
            self.observer.automation_failed(&entry.id, &tab.id, "The agent left the terminal before the automation turn completed.");
        }
    }

    /// The process a tab's CLI ran as is gone: the pane exited.
    ///
    /// When the app follows terminals and the CLI went by itself (the reader
    /// exited it, or it died), the tab becomes a terminal: a turn it was in
    /// the middle of is closed as interrupted and said so once, nothing is
    /// raised for the reader to recover from, and a shell takes the CLI's
    /// place in the same pane. A pane the app closed (Stop, a restart, the
    /// tab or the app going) is the app's own doing and changes nothing
    /// here, and neither does anything on a runtime that does not follow.
    pub(super) fn cli_gone(&self, rt_arc: &Arc<Mutex<TabRuntime>>, pane: &str, code: Option<i32>, legacy_turn_status: TurnStatus) {
        let tail = match &rt_arc.lock().unwrap().engine {
            Engine::Cli(p) => p.tail.clone(),
            _ => return,
        };
        let closing = self.follow.closing.load(Ordering::SeqCst);
        let follows = self.follows() && !closing && self.terminals.is_live(pane);
        if follows {
            self.pump(rt_arc, &tail);
        }
        let mut rt = rt_arc.lock().unwrap();
        // A delayed exit from a replaced pane must not settle its successor.
        let Engine::Cli(p) = &rt.engine else { return };
        if p.pane_id != pane || self.terminals.is_running(pane) {
            return;
        }
        let by_hand = p.by_hand.is_some();
        let (session, tab) = (rt.session_id.clone(), rt.tab_id.clone());
        let turn_was_open = rt.turn_open;
        if !follows {
            if by_hand {
                // Followed, and closed by the app with its pane. If the tab
                // outlives that (its session was moved, say), it is a
                // terminal, to be given a shell when it is next opened. Not
                // when it is the app itself that is going: the tab is then
                // its agent's at the next launch, as it is after a crash.
                self.release_cli(&mut rt);
                if !closing {
                    self.set_front(&rt, Front::Terminal);
                }
                return;
            }
            let recovery = rt.recovery.or(turn_was_open.then_some(RecoveryKind::Failed));
            if turn_was_open {
                self.close_open_turn(&mut rt, legacy_turn_status, None);
            }
            self.release_cli(&mut rt);
            if let Some(kind) = recovery {
                self.needs_recovery(&mut rt, kind);
            }
        } else {
            self.became_terminal(&mut rt, Gone::Exited);
        }
        drop(rt);
        if turn_was_open {
            let detail = code.map(|value| format!(" with exit code {value}")).unwrap_or_else(|| " from a signal".into());
            self.observer.automation_failed(&session, &tab, &format!("The agent process exited{detail} before the automation turn completed."));
        }
        // The app's own CLI was the pane's process, so the pane went with it:
        // the tab needs a shell to be the terminal it now is. A CLI started
        // by hand leaves the shell it was started from.
        if follows && !by_hand {
            if let Err(error) = self.shell_for(&session, &tab) {
                log::warn!("open a shell in {pane} after its agent exited: {error:#}");
            }
        }
    }

    /// The tab's agent is no longer in front of its terminal. Not an error:
    /// the tab simply is a terminal now. A turn cut short is closed as
    /// interrupted, and the log says what happened in one line.
    fn became_terminal(&self, rt: &mut TabRuntime, gone: Gone) {
        if let Engine::Cli(p) = &rt.engine {
            rt.left_at = Some((p.tail.path(), p.tail.offset()));
        }
        let agent = crate::harness::display_name(&rt.harness);
        let mid_turn = rt.turn_open;
        // What it was asking went with it. Cancelled, as Stop says it, and
        // not lapsed: a lapsed request is one the reader is owed a look at,
        // and reading the log again would raise that for a tab with nothing
        // wrong with it.
        self.cancel_asks(rt);
        self.end_open_turn(rt, TurnStatus::Aborted, None);
        self.release_cli(rt);
        let text = match (gone, mid_turn) {
            (Gone::Replaced, _) => None,
            (Gone::Exited, false) => Some(format!("{agent} exited.")),
            (Gone::Exited, true) => Some(format!("{agent} exited before the turn finished.")),
            (Gone::Suspended, false) => Some(format!("{agent} was suspended in the terminal.")),
            (Gone::Suspended, true) => Some(format!("{agent} was suspended in the terminal before the turn finished.")),
        };
        if let Some(text) = text {
            self.publish(rt, Payload::Status { text }, None);
        }
        self.set_front(rt, Front::Terminal);
        self.announce_tab(rt);
    }

    fn set_front(&self, rt: &TabRuntime, front: Front) {
        // A tab that is being closed is no longer there to be anything.
        if let Err(error) = index::update_tab(&rt.session_id, &rt.tab_id, |tab| {
            tab.follow.front = front;
            Ok(())
        }) {
            log::debug!("record what {}/{} is now: {error:#}", rt.session_id, rt.tab_id);
        }
    }

    /// Tell every window what the tab is now.
    fn announce_tab(&self, rt: &TabRuntime) {
        if let Ok(session) = index::get(&rt.session_id) {
            self.sink.emit("session_updated", &session);
        }
        self.sink.emit(crate::cloud_agents::TABS_CHANGED, &serde_json::json!({ "tabId": rt.tab_id }));
        // How many agents are running is counted from what each tab holds.
        self.sink.emit(crate::status::resources::CHANGED_EVENT, &());
    }

    /// Make sure a tab that is a terminal has a shell in its pane, and say
    /// which pane that is.
    pub(super) fn shell_for(&self, session_id: &str, tab_id: &str) -> Result<()> {
        // One at a time for a tab, under its lock: the exit that makes a tab
        // a terminal and the window that then opens it both come here, and
        // two shells started at once for one pane would each end the other.
        let rt_arc = self.runtime(session_id, tab_id)?;
        let rt = rt_arc.lock().unwrap();
        if rt.restart_claim.is_some() { return Ok(()); }
        // An agent took the tab in the meantime: its pane is that agent's.
        if matches!(rt.engine, Engine::Cli(_)) {
            self.announce_pane(&rt);
            return Ok(());
        }
        let mut entry = index::get(session_id)?;
        // Its hand-started agent is gone and nothing said so (the app closed
        // its pane): it is a terminal.
        if entry.tab(tab_id).is_some_and(TabEntry::by_hand) {
            entry = index::update_session(session_id, |session| {
                if let Some(tab) = session.tab_mut(tab_id) {
                    tab.follow.front = Front::Terminal;
                }
                Ok(session.clone())
            })?;
            self.sink.emit("session_updated", &entry);
        }
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?;
        let pane = tab.pane_id();
        if !self.terminals.is_running(&pane) {
            if entry.is_quick() && crate::store::quick::is_scratch(&entry.id, &entry.cwd) {
                crate::store::quick::create(&entry.id).context("make the quick chat's scratch directory")?;
            }
            let spec = pty::PaneSpec { cwd: &entry.cwd, cols: CLI_PANE_SIZE.0, rows: CLI_PANE_SIZE.1, command: None, env: &[] };
            self.terminals.respawn(self.sink.clone(), &pane, spec).context("open the tab's shell")?;
        }
        self.sink.emit("tab_pty", &Self::terminal_pane_event(&entry.id, tab));
        Ok(())
    }

    pub(super) fn terminal_pane_event(session_id: &str, tab: &TabEntry) -> TabPtyEvent {
        TabPtyEvent { session_id: session_id.to_string(), tab_id: tab.id.clone(), pane_id: tab.pane_id(), command: String::new(), harness: tab.harness.clone(), by_hand: false, terminal: true }
    }

    /// Whether the shell of a tab that is a terminal is at its prompt. The
    /// reader may be running something of their own there, and that is not
    /// the app's to end.
    fn shell_is_idle(&self, tab: &TabEntry) -> Result<()> {
        let pane = tab.pane_id();
        if self.terminals.fronts().iter().any(|front| front.id == pane && front.foreground != front.pid) {
            return Err(Refusal("This tab's terminal is running something. Stop it there first, or use another tab.".into()).into());
        }
        Ok(())
    }

    /// A prompt was sent to a tab that is a terminal: start the tab's agent
    /// again on its conversation, in the place of the idle shell.
    pub(super) fn wake(&self, rt: &mut TabRuntime, tab: &TabEntry) -> Result<()> {
        self.shell_is_idle(tab)?;
        self.set_front(rt, Front::Agent);
        self.announce_tab(rt);
        Ok(())
    }

    /// Start a tab's agent again, on the conversation it holds or on one it
    /// held before: the chat's "Resume" for a tab that is a terminal.
    pub fn resume_conversation(&self, session_id: &str, tab_id: &str, harness: &str, provider_session_id: &str) -> Result<()> {
        if pty_first(harness).is_none() {
            bail!("{} conversations cannot be resumed here.", crate::harness::display_name(harness));
        }
        let rt_arc = self.runtime(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.stopping {
            bail!("Stop has not confirmed local process exit. Retry Stop before resuming.");
        }
        if rt.child.is_some() || matches!(rt.engine, Engine::Cli(_)) {
            bail!("An agent is running in this tab. Exit it before resuming another conversation.");
        }
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?;
        if !tab.conversations().any(|(of, id, _)| of == harness && id == provider_session_id) {
            bail!("That conversation is not one of this tab's.");
        }
        self.shell_is_idle(tab)?;
        self.settle_conversation(&mut rt, harness, Some(&Located { provider_session_id: provider_session_id.to_string(), transcript: None }), false)?;
        self.set_front(&rt, Front::Agent);
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?.clone();
        let started = self.start_cli(&mut rt, &rt_arc, &entry, &tab);
        if started.is_err() {
            self.set_front(&rt, Front::Terminal);
        }
        self.announce_tab(&rt);
        started.map(|_| ())
    }

    /// Why nothing may be typed for the tab's CLI, when it is one the reader
    /// started by hand and it no longer has the terminal: it exited or was
    /// suspended, and its shell is what would read the keys. `None` while it
    /// is in front, and for a CLI the app runs, which is its pane's own
    /// process.
    pub(super) fn left_the_terminal(&self, rt: &TabRuntime) -> Option<String> {
        let Engine::Cli(CliTab { by_hand: Some(by), pane_id, .. }) = &rt.engine else { return None };
        let in_front = self.terminals.fronts().iter().any(|front| &front.id == pane_id && front.foreground == by.agent.job);
        (!in_front).then(|| format!("{} is no longer running in this tab's terminal.", crate::harness::display_name(&rt.harness)))
    }

    /// Why a change that needs the CLI restarted cannot be made to one the
    /// reader started by hand: the app did not launch it and does not
    /// replace it. `None` for a CLI the app runs.
    pub(super) fn by_hand_refusal(rt: &TabRuntime, what: &str) -> Option<String> {
        match &rt.engine {
            Engine::Cli(CliTab { by_hand: Some(_), .. }) => {
                let agent = crate::harness::display_name(&rt.harness);
                Some(format!("{agent} was started by hand in this tab's terminal, so TerminalX cannot restart it to change {what}. Change it in the terminal, or exit {agent} there and resume the conversation from the chat."))
            }
            _ => None,
        }
    }

    /// Stop a CLI the reader started by hand: its own job is ended, and the
    /// shell it was started from is left. The tab is a terminal afterwards.
    pub(super) fn stop_by_hand(&self, rt_arc: &Arc<Mutex<TabRuntime>>) -> Result<()> {
        let (agent, pane) = match &rt_arc.lock().unwrap().engine {
            Engine::Cli(CliTab { by_hand: Some(by), pane_id, .. }) => (by.agent.clone(), pane_id.clone()),
            _ => return Ok(()),
        };
        crate::harness::host::terminate(agent.job);
        let deadline = Instant::now() + RESTART_WAIT;
        while agent.pids.iter().any(|pid| crate::harness::host::is_alive(*pid)) {
            if Instant::now() >= deadline {
                bail!("Local process exit could not be confirmed. Retry Stop before resuming.");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // The watcher would say so within a moment; the reader pressed Stop
        // and is told now.
        self.follow.fronts.lock().unwrap().remove(&pane);
        self.sink.emit(PANE_AGENT_EVENT, &PaneAgent { pane_id: pane.clone(), harness: None });
        self.agent_left(&pane);
        Ok(())
    }

    /// Use `locator` to find hand-started CLIs' conversations, and follow
    /// terminals without the watcher: a test says what is in front itself.
    #[cfg(test)]
    pub(crate) fn follow_with(&self, locator: Arc<dyn Locator>) {
        *self.follow.locator.lock().unwrap() = locator;
        self.follow.enabled.store(true, Ordering::SeqCst);
    }
}
