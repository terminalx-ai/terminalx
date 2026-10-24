//! The session index: one entry per session, each holding its tabs.
//!
//! A session is a place (a worktree or a project checkout) with a title; a tab
//! is one conversation with one agent in that place. The index is what the
//! sidebar draws and what resume reads, so it is written **before** any child
//! is spawned — a session whose agent fails to start is still visible.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[path = "transaction.rs"]
mod transaction;

const TRANSACTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The launch mode of any session or tab whose creator did not name one —
/// the desktop, the CLI, the relay, a cloud launch, an automation — and of a
/// stored tab that has none. Only an explicit mode overrides it.
pub const DEFAULT_PERMISSION_MODE: &str = "bypassPermissions";

/// A requested mode, or the default when none was named. Blank is not a mode.
pub fn permission_mode_or_default(mode: Option<&str>) -> String {
    match mode.map(str::trim) {
        Some(mode) if !mode.is_empty() => mode.to_string(),
        _ => DEFAULT_PERMISSION_MODE.into(),
    }
}

/// A mode as a request carries it: blank is the same as absent, so the
/// caller's own default (`DEFAULT_PERMISSION_MODE` for a new tab, "no change"
/// for a settings update) applies rather than an "unknown mode" refusal.
pub fn requested_mode(mode: Option<String>) -> Option<String> {
    mode.filter(|mode| !mode.trim().is_empty())
}

/// Serde's side of the same rule, for a stored tab whose mode is `null` or
/// blank — written by a build that knew no mode.
fn mode_or_default<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<String, D::Error> {
    let mode: Option<String> = Option::deserialize(d)?;
    Ok(permission_mode_or_default(mode.as_deref()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TabStatus {
    #[default]
    Idle,
    InProgress,
    /// Finished and not yet looked at.
    Completed,
    /// Waiting on the reader (permission or a question).
    Waiting,
}

/// What is in a tab's terminal (#437). A tab follows it: the same tab is an
/// agent's while that agent runs there and a plain terminal when it does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Front {
    /// The tab's agent, run by the app: running, or started when the tab is
    /// next opened. What every tab was before tabs followed their terminal.
    #[default]
    Agent,
    /// The tab's agent, started by hand in the tab's terminal. The app
    /// follows the conversation that CLI is writing and never restarts it.
    ByHand,
    /// No agent: a shell, and whatever the reader runs in it.
    Terminal,
}

impl Front {
    fn is_agent(&self) -> bool {
        *self == Self::Agent
    }
}

/// A value this build does not know is read as an ordinary agent tab, so an
/// entry a newer build wrote does not cost the reader the whole index.
impl<'de> Deserialize<'de> for Front {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let front: Option<String> = Option::deserialize(d)?;
        Ok(match front.as_deref() {
            Some("by_hand") => Self::ByHand,
            Some("terminal") => Self::Terminal,
            _ => Self::Agent,
        })
    }
}

/// A conversation a tab held before the one it holds now (#437): another
/// agent was started in the tab's terminal, or the same agent was started on
/// something else. Its events stay in the tab's log, under `id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PastConversation {
    /// What its events are marked with (`Payload::Conversation`); absent for
    /// the conversation the tab began with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub harness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default = "default_mode", deserialize_with = "mode_or_default")]
    pub permission_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_max: Option<u64>,
    /// It was started outside the app's own launches (see `Follow::adopted`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub adopted: bool,
    /// When the tab moved on from it.
    #[serde(default)]
    pub ended: String,
}

/// How a tab follows its terminal (#437). Flattened into the tab's entry, and
/// all of it left out for a tab that is simply the agent it was created for,
/// so such an entry is written exactly as before.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Follow {
    #[serde(default, skip_serializing_if = "Front::is_agent")]
    pub front: Front,
    /// The pane the tab lives in when that is not its own (`tab:<id>`): the
    /// shell an agent was first started in by hand. It lasts as long as that
    /// pane does; no pane survives the app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane: Option<String>,
    /// What the tab is called while it is a terminal ("Terminal 2").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    /// The reader chose the tab's `title`. It is then the tab's name whatever
    /// runs in it, and no conversation renames it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub title_pinned: bool,
    /// Which conversation the tab's events belong to now. Absent for the one
    /// the tab began with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<String>,
    /// The conversation the tab holds was started by hand, not by the app.
    /// Its transcript is the reader's own, as one made in any other terminal
    /// is: the app follows it and may resume it, and never deletes it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub adopted: bool,
    /// The conversations before it, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<PastConversation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabEntry {
    pub id: String,
    /// Harness name, kept verbatim so an entry written by a newer build survives.
    pub harness: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    /// A model the app asked for that the provider has not confirmed yet.
    /// `model` stays what is running until it does (`harness::settings`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_effort: Option<String>,
    /// The mode the agent is in: what its next tool call is judged under.
    #[serde(default = "default_mode", deserialize_with = "mode_or_default")]
    pub permission_mode: String,
    /// A mode the app asked for that waits for the restart that applies it
    /// (`harness::settings`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_permission_mode: Option<String>,
    /// The harness's own conversation id (Claude session id, Codex thread id).
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub status: TabStatus,
    pub created: String,
    #[serde(default)]
    pub modified: String,
    /// Context window occupancy as last reported, so the ring survives restart.
    #[serde(default)]
    pub context_used: Option<u64>,
    #[serde(default)]
    pub context_max: Option<u64>,
    /// Provider conversation this tab was forked from. It drives the first
    /// start only (a tab with an id of its own resumes that), and stays set
    /// afterwards so the parent's transcript is not deleted before the fork
    /// has one of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_from: Option<String>,
    #[serde(flatten, default)]
    pub follow: Follow,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

impl TabEntry {
    /// The terminal pane the tab lives in: its own, unless it took over a
    /// shell's (#437).
    pub fn pane_id(&self) -> String {
        self.follow.pane.clone().unwrap_or_else(|| format!("tab:{}", self.id))
    }

    /// The pane the tab lived in is gone (the app restarted, or the tab was
    /// closed): it has its own from here on, and an agent that was started
    /// by hand went with the terminal it was started in. Its conversation is
    /// the tab's, for the app to resume when the tab is opened. A tab that
    /// was a terminal is still one.
    pub fn lose_pane(&mut self) {
        self.follow.pane = None;
        if self.follow.front == Front::ByHand {
            self.follow.front = Front::Agent;
        }
    }

    /// Whether the tab is a plain terminal now, with no agent in it.
    pub fn is_terminal(&self) -> bool {
        self.follow.front == Front::Terminal
    }

    /// Whether the agent in the tab was started by hand in its terminal.
    pub fn by_hand(&self) -> bool {
        self.follow.front == Front::ByHand
    }

    /// The conversation the tab holds now, as a record to keep when it moves
    /// on to another.
    pub fn past(&self) -> PastConversation {
        PastConversation {
            id: self.follow.conversation.clone(),
            harness: self.harness.clone(),
            provider_session_id: self.provider_session_id.clone(),
            title: (!self.follow.title_pinned).then(|| self.title.clone()).flatten(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            permission_mode: self.permission_mode.clone(),
            context_used: self.context_used,
            context_max: self.context_max,
            adopted: self.follow.adopted,
            ended: now(),
        }
    }

    /// Every agent conversation the tab holds or has held, as (harness, the
    /// agent's own id for it, whether it was started outside the app).
    pub fn conversations(&self) -> impl Iterator<Item = (&str, &str, bool)> {
        let now = self.provider_session_id.as_deref().map(|id| (self.harness.as_str(), id, self.follow.adopted));
        let before = self.follow.history.iter().filter_map(|past| Some((past.harness.as_str(), past.provider_session_id.as_deref()?, past.adopted)));
        now.into_iter().chain(before)
    }
}

fn default_mode() -> String {
    DEFAULT_PERMISSION_MODE.into()
}

/// The tracker issue a session was started from, enough to link back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueRef {
    pub provider: String,
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub url: String,
}

/// How a session's issue link came about, when it was not started on the
/// issue (#441). Automatic links are shown as such and can be removed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IssueLinkSource {
    /// The branch or worktree name carries the issue's number or identifier.
    Branch,
    /// A pull request the session's branch opened closes the issue.
    PullRequest,
    /// The first prompt names the issue.
    Prompt,
    /// Linked by hand.
    Manual,
}

/// What the work status of a session says about its issue (#441).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueWork {
    /// Absent while `issue` is the one the session was started on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<IssueLinkSource>,
    /// Issue URLs unlinked by hand: never linked again automatically.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unlinked: Vec<String>,
    /// "Don't share this session": its work status never leaves this machine.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub private: bool,
}

impl IssueWork {
    pub fn is_empty(&self) -> bool {
        self.link.is_none() && self.unlinked.is_empty() && !self.private
    }
}

/// The automation run that created this ordinary session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRef {
    pub id: String,
    pub name: String,
    pub run_id: String,
    pub run_number: u64,
}

/// Provenance for a session whose checkout has been deleted. Operationally
/// the session moves to the project checkout, but the sidebar must not imply
/// that its existing transcript was created there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemovedWorkspace {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
}

/// The repo a chat's agent is working in: its root, and the branch checked out there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatLink {
    pub path: String,
    #[serde(default)]
    pub branch: Option<String>,
}

/// What a session belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    /// A session of a project the reader attached.
    #[default]
    Project,
    /// A quick chat: it has no project. It runs in a scratch directory of its
    /// own under the TerminalX home, or in a folder the reader pointed it at,
    /// and has no worktree, branch or base.
    Quick,
}

impl SessionKind {
    fn is_project(&self) -> bool {
        *self == Self::Project
    }
}

/// A kind this build does not know is read as an ordinary session rather than
/// failing the whole index: one entry a newer build wrote must not cost the
/// reader every session they have.
impl<'de> Deserialize<'de> for SessionKind {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let kind: Option<String> = Option::deserialize(d)?;
        Ok(match kind.as_deref() {
            Some("quick") => Self::Quick,
            _ => Self::Project,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    /// Left out of the file for an ordinary session, so its entry is written
    /// exactly as before.
    #[serde(default, skip_serializing_if = "SessionKind::is_project")]
    pub kind: SessionKind,
    /// The project the session belongs to. A quick chat has none: this is
    /// then its scratch directory (see `store::quick`), which is a real,
    /// plain folder, so a build that knows nothing of quick chats reads the
    /// entry as a session in a folder it has no project for. Code that means
    /// "the reader's project" asks [`SessionEntry::project`] instead.
    pub project_path: String,
    /// Where agents run. The worktree for a worktree session, else the project.
    pub cwd: String,
    #[serde(default)]
    pub worktree_name: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// Base the worktree forked from, for the first turn's changes baseline.
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_base: Option<crate::git::WorktreeBase>,
    #[serde(default)]
    pub worktree_removed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_workspace: Option<RemovedWorkspace>,
    /// The tracker issue the session works on: the one it was started from,
    /// or one linked later (see `issue_work.link`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<IssueRef>,
    #[serde(default, skip_serializing_if = "IssueWork::is_empty")]
    pub issue_work: IssueWork,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation: Option<AutomationRef>,
    pub title: String,
    pub created: String,
    pub modified: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub tabs: Vec<TabEntry>,
    #[serde(default)]
    pub active_tab: Option<String>,
    /// For a chat (a session in the store's Chats folder): the repo its agent
    /// last worked in, and on which branch, so the chat shows under it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<ChatLink>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

impl SessionEntry {
    pub fn is_quick(&self) -> bool {
        self.kind == SessionKind::Quick
    }
    /// The project this session belongs to; `None` for a quick chat.
    pub fn project(&self) -> Option<&str> {
        (!self.is_quick()).then_some(self.project_path.as_str())
    }
    pub fn tab(&self, tab_id: &str) -> Option<&TabEntry> {
        self.tabs.iter().find(|t| t.id == tab_id)
    }
    pub fn tab_mut(&mut self, tab_id: &str) -> Option<&mut TabEntry> {
        self.tabs.iter_mut().find(|t| t.id == tab_id)
    }
}

/// How one workspace's tabs are arranged. A workspace is one checkout, and its
/// tabs are the agent tabs of every session that runs there, its shells and
/// its browser pages: one row, whatever session a tab belongs to.
///
/// A tab is named by its kind and id: `agent:<tab id>`, `terminal:<pane id>`,
/// `browser:<page id>`. The key of a workspace is the window's to choose (the
/// checkout's path, or a quick chat's own id); it is opaque here.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabLayout {
    /// The tabs in the order the reader put them in. A tab not listed comes
    /// after these, oldest first.
    #[serde(default)]
    pub order: Vec<String>,
    /// Tabs kept at the left, drawn as an icon and left open by the bulk closes.
    #[serde(default)]
    pub pinned: Vec<String>,
    /// Tabs that raise no banner, notice or tone.
    #[serde(default)]
    pub muted: Vec<String>,
    /// The reader's own title for a tab. An agent tab's is also its
    /// `TabEntry::title`, so everything that lists a session's tabs shows it.
    #[serde(default)]
    pub titles: BTreeMap<String, String>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

impl TabLayout {
    fn is_empty(&self) -> bool {
        self.order.is_empty() && self.pinned.is_empty() && self.muted.is_empty() && self.titles.is_empty() && self.unknown.is_empty()
    }

    /// Say of `to` what the layout said of `from`. False when it said nothing.
    fn rename(&mut self, from: &str, to: &str) -> bool {
        let mut renamed = false;
        for keys in [&mut self.order, &mut self.pinned, &mut self.muted] {
            if !keys.iter().any(|key| key == from) {
                continue;
            }
            renamed = true;
            // A layout that already names `to` keeps what it says of it.
            if keys.iter().any(|key| key == to) {
                keys.retain(|key| key != from);
            } else {
                for key in keys.iter_mut().filter(|key| *key == from) {
                    *key = to.to_string();
                }
            }
        }
        if let Some(title) = self.titles.remove(from) {
            renamed = true;
            self.titles.entry(to.to_string()).or_insert(title);
        }
        renamed
    }
}

const AGENT_TAB: &str = "agent:";
const SHELL_TAB: &str = "terminal:";

/// An agent tab the reader closed, kept so it can be reopened with its
/// conversation: the entry as it was, and the log that goes with it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTab {
    pub session_id: String,
    pub tab: TabEntry,
    pub closed_at: String,
}

/// How many closed tabs a session keeps; the oldest goes when one more is closed.
pub const CLOSED_TABS_KEPT: usize = 10;

/// What every window needs about tabs beyond the sessions themselves.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    /// Workspace key to its layout; a workspace nobody arranged has none.
    pub workspaces: BTreeMap<String, TabLayout>,
    /// Closed agent tabs, oldest first.
    pub closed: Vec<ClosedTab>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexFile {
    #[serde(default)]
    sessions: Vec<SessionEntry>,
    /// Left out of the file until a workspace is arranged, so an index nobody
    /// reordered is written exactly as before.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    workspace_tabs: BTreeMap<String, TabLayout>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    closed_tabs: Vec<ClosedTab>,
    #[serde(flatten, default)]
    unknown: BTreeMap<String, serde_json::Value>,
}

fn file_path() -> Result<PathBuf> {
    Ok(super::sessions_dir()?.join("index.json"))
}

fn load_file() -> Result<IndexFile> {
    Ok(super::read_json::<IndexFile>(&file_path()?)?.unwrap_or_default())
}

/// Counts the index's writes in this process, so a watcher (the work status
/// publisher, #441) can tell something changed without reading the file.
static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn revision() -> u64 {
    REVISION.load(std::sync::atomic::Ordering::Relaxed)
}

fn save_file(file: &mut IndexFile) -> Result<()> {
    // A closed tab goes with its session: there is nothing left to reopen it into.
    let IndexFile { sessions, closed_tabs, .. } = file;
    closed_tabs.retain(|closed| sessions.iter().any(|session| session.id == closed.session_id));
    super::write_json(&file_path()?, &*file)?;
    REVISION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

fn with_file_lock<R>(f: impl FnOnce() -> Result<R>) -> Result<R> {
    transaction::run(&file_path()?.with_extension("lock"), TRANSACTION_TIMEOUT, f)
}

fn update_file<R>(f: impl FnOnce(&mut IndexFile) -> Result<R>) -> Result<R> {
    with_file_lock(|| {
        let mut file = load_file()?;
        let r = f(&mut file)?;
        save_file(&mut file)?;
        Ok(r)
    })
}

pub fn load() -> Result<Vec<SessionEntry>> {
    let mut sessions = load_file()?.sessions;
    super::message_activity::project(&mut sessions)?;
    Ok(sessions)
}

/// Replace the sessions. What the file holds besides them (tab layouts,
/// closed tabs, fields a newer build wrote) is kept. Everything outside
/// tests goes through [`update`]; tests lay an index down with this.
#[cfg(test)]
pub fn save(sessions: &[SessionEntry]) -> Result<()> {
    // The sessions are written whatever the file held before, as they always were.
    with_file_lock(|| {
        let mut file = load_file().unwrap_or_default();
        file.sessions = sessions.to_vec();
        save_file(&mut file)
    })
}

#[cfg(test)]
#[path = "index_transaction_tests.rs"]
mod transaction_tests;

/// Apply `f` to the whole index under the write lock and persist it.
pub fn update<R>(f: impl FnOnce(&mut Vec<SessionEntry>) -> Result<R>) -> Result<R> {
    update_file(|file| f(&mut file.sessions))
}

pub fn tab_state() -> Result<TabState> {
    let file = load_file()?;
    Ok(TabState { workspaces: file.workspace_tabs, closed: file.closed_tabs })
}

/// Save how a workspace's tabs are arranged; an empty layout forgets it.
///
/// Each session's own `tabs` are put in the same relative order, so whatever
/// lists a session's tabs without knowing about layouts (the CLI, a phone, a
/// paired device) shows them the way the strip does. Returns the sessions
/// whose tabs moved. No session's `modified` changes: arranging tabs is not
/// activity, and must not reorder the sidebar.
pub fn set_tab_layout(workspace: &str, mut layout: TabLayout) -> Result<Vec<SessionEntry>> {
    let mut seen = std::collections::HashSet::new();
    layout.order.retain(|key| seen.insert(key.clone()));
    update_file(|file| {
        let rank: std::collections::HashMap<&str, usize> =
            layout.order.iter().enumerate().filter_map(|(at, key)| key.strip_prefix(AGENT_TAB).map(|id| (id, at))).collect();
        let mut moved = Vec::new();
        for session in &mut file.sessions {
            let before: Vec<String> = session.tabs.iter().map(|tab| tab.id.clone()).collect();
            // Stable: tabs the layout does not name keep their places after the ones it does.
            session.tabs.sort_by_key(|tab| rank.get(tab.id.as_str()).copied().unwrap_or(usize::MAX));
            if session.tabs.iter().map(|tab| &tab.id).ne(before.iter()) {
                moved.push(session.clone());
            }
        }
        if layout.is_empty() {
            file.workspace_tabs.remove(workspace);
        } else {
            file.workspace_tabs.insert(workspace.to_string(), layout);
        }
        Ok(moved)
    })
}

/// Explicit legacy layout cleanup. Window startup must retain owner shells.
#[cfg_attr(not(test), expect(dead_code, reason = "Preserve the explicit layout maintenance API; desktop attachment must not call it."))]
pub fn forget_shell_tabs() -> Result<()> {
    with_file_lock(|| {
        let mut file = load_file()?;
        let mut changed = false;
        for layout in file.workspace_tabs.values_mut() {
            let before = layout.order.len() + layout.pinned.len() + layout.muted.len() + layout.titles.len();
            let shell = |key: &String| key.starts_with(SHELL_TAB);
            layout.order.retain(|key| !shell(key));
            layout.pinned.retain(|key| !shell(key));
            layout.muted.retain(|key| !shell(key));
            layout.titles.retain(|key, _| !shell(key));
            changed |= before != layout.order.len() + layout.pinned.len() + layout.muted.len() + layout.titles.len();
        }
        if !changed {
            return Ok(());
        }
        file.workspace_tabs.retain(|_, layout| !layout.is_empty());
        save_file(&mut file)
    })
}

/// A shell became an agent's tab (#437), under the tab's own id. What the
/// reader arranged for the shell (its place in the row, a pin, a mute, a
/// title) is the tab's from here on. Returns whether any layout named it.
pub fn shell_became_tab(pane: &str, tab_id: &str) -> Result<bool> {
    with_file_lock(|| {
        let (shell, tab) = (format!("{SHELL_TAB}{pane}"), format!("{AGENT_TAB}{tab_id}"));
        let mut file = load_file()?;
        let mut renamed = false;
        for layout in file.workspace_tabs.values_mut() {
            renamed |= layout.rename(&shell, &tab);
        }
        if renamed {
            save_file(&mut file)?;
        }
        Ok(renamed)
    })
}

/// Take an agent tab out of its session. With `keep` it stays reopenable;
/// returns the tabs (session id, tab id) whose logs nothing refers to any
/// more: this one when it is not kept, and the closed tabs it pushed out.
pub fn close_tab(session_id: &str, tab_id: &str, keep: bool) -> Result<Vec<(String, String)>> {
    update_file(|file| {
        let session = file.sessions.iter_mut().find(|s| s.id == session_id).ok_or_else(|| anyhow!("session {session_id} not found"))?;
        let Some(at) = session.tabs.iter().position(|tab| tab.id == tab_id) else {
            return Ok(Vec::new());
        };
        session.modified = now();
        let tab = session.tabs.remove(at);
        if session.active_tab.as_deref() == Some(tab_id) {
            session.active_tab = session.tabs.last().map(|t| t.id.clone());
        }
        if !keep {
            return Ok(vec![(session_id.to_string(), tab.id)]);
        }
        file.closed_tabs.push(ClosedTab { session_id: session_id.to_string(), tab, closed_at: now() });
        let mine = file.closed_tabs.iter().filter(|closed| closed.session_id == session_id).count();
        let mut over = mine.saturating_sub(CLOSED_TABS_KEPT);
        let mut dropped = Vec::new();
        file.closed_tabs.retain(|closed| {
            if over == 0 || closed.session_id != session_id {
                return true;
            }
            over -= 1;
            dropped.push((closed.session_id.clone(), closed.tab.id.clone()));
            false
        });
        Ok(dropped)
    })
}

/// Put a closed tab back into its session, as its active tab. Its log and the
/// agent's own conversation were never touched, so it resumes where it was.
pub fn reopen_tab(session_id: &str, tab_id: &str) -> Result<TabEntry> {
    update_file(|file| {
        let at = file
            .closed_tabs
            .iter()
            .position(|closed| closed.session_id == session_id && closed.tab.id == tab_id)
            .ok_or_else(|| anyhow!("tab {tab_id} is not a closed tab of session {session_id}"))?;
        let session = file.sessions.iter_mut().find(|s| s.id == session_id).ok_or_else(|| anyhow!("session {session_id} not found"))?;
        let mut tab = file.closed_tabs.remove(at).tab;
        // Nothing ran while it was closed, and the pane it lived in went with it.
        tab.status = TabStatus::Idle;
        tab.lose_pane();
        session.tabs.retain(|other| other.id != tab.id);
        session.tabs.push(tab.clone());
        session.active_tab = Some(tab.id.clone());
        session.modified = now();
        Ok(tab)
    })
}

pub fn get(session_id: &str) -> Result<SessionEntry> {
    load()?
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| anyhow!("session {session_id} not found"))
}

pub fn update_session<R>(session_id: &str, f: impl FnOnce(&mut SessionEntry) -> Result<R>) -> Result<R> {
    update(|sessions| {
        let s = sessions
            .iter_mut()
            .find(|s| s.id == session_id)
            .ok_or_else(|| anyhow!("session {session_id} not found"))?;
        s.modified = now();
        f(s)
    })
}

pub fn update_tab<R>(session_id: &str, tab_id: &str, f: impl FnOnce(&mut TabEntry) -> Result<R>) -> Result<R> {
    update_session(session_id, |s| {
        let t = s.tab_mut(tab_id).ok_or_else(|| anyhow!("tab {tab_id} not found"))?;
        t.modified = now();
        f(t)
    })
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Worktree names taken by sessions that still hold (or lazily expect) one.
pub fn claimed_worktree_names(sessions: &[SessionEntry]) -> Vec<String> {
    sessions
        .iter()
        .filter(|s| !s.worktree_removed)
        .filter_map(|s| s.worktree_name.clone())
        .collect()
}

/// Retarget a session after its checkout is deleted while recording where
/// the transcript was produced. All worktree-deletion entry points use this
/// transition so none can silently file historical sessions under main.
pub fn mark_workspace_removed(session: &mut SessionEntry, project_branch: Option<String>) {
    if session.removed_workspace.is_none() {
        let name = session
            .worktree_name
            .clone()
            .or_else(|| {
                PathBuf::from(&session.cwd)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| "Removed workspace".into());
        session.removed_workspace = Some(RemovedWorkspace {
            path: session.cwd.clone(),
            name,
            branch: session.branch.clone(),
        });
    }
    session.cwd = session.project_path.clone();
    session.worktree_name = None;
    session.worktree_removed = true;
    // A quick chat that was pointed at the workspace goes back to its scratch
    // directory, which is on no branch: the project's is not its own.
    session.branch = if session.is_quick() { None } else { project_branch };
    session.base_ref = None;
    for tab in &mut session.tabs {
        tab.status = TabStatus::Idle;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> SessionEntry {
        SessionEntry {
            id: id.into(),
            kind: SessionKind::Project,
            project_path: "/p".into(),
            cwd: "/p".into(),
            worktree_name: None,
            branch: None,
            base_ref: None,
            worktree_base: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: None,
            issue_work: Default::default(),
            automation: None,
            title: "t".into(),
            created: now(),
            modified: now(),
            archived: false,
            pinned: false,
            tabs: vec![],
            active_tab: None,
            link: None,
            unknown: BTreeMap::new(),
        }
    }

    fn tab(id: &str) -> TabEntry {
        serde_json::from_value(serde_json::json!({"id": id, "harness": "claude", "created": "x"})).unwrap()
    }

    fn layout(order: &[&str]) -> TabLayout {
        TabLayout { order: order.iter().map(|key| key.to_string()).collect(), ..Default::default() }
    }

    fn tab_ids(session_id: &str) -> Vec<String> {
        get(session_id).unwrap().tabs.into_iter().map(|tab| tab.id).collect()
    }

    #[test]
    fn a_tab_layout_is_saved_and_puts_each_sessions_tabs_in_the_same_order() {
        let _home = crate::store::temp_home();
        let (mut a, mut b) = (entry("a"), entry("b"));
        a.tabs = vec![tab("a1"), tab("a2"), tab("a3")];
        b.tabs = vec![tab("b1"), tab("b2")];
        a.modified = "before".into();
        save(&[a, b]).unwrap();

        // One order for the whole workspace: tabs of two sessions interleaved, with a shell between them.
        let mut wanted = layout(&["agent:b2", "agent:a3", "terminal:a:1", "agent:a1", "agent:b1", "agent:a3"]);
        wanted.pinned = vec!["agent:b2".into()];
        wanted.titles.insert("browser:p1".into(), "Docs".into());
        let moved = set_tab_layout("/p", wanted).unwrap();

        assert_eq!(moved.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        // A tab the layout does not name (a2) keeps its place after the ones it does.
        assert_eq!(tab_ids("a"), ["a3", "a1", "a2"]);
        assert_eq!(tab_ids("b"), ["b2", "b1"]);
        // Arranging tabs is not activity.
        assert_eq!(get("a").unwrap().modified, "before");

        let saved = &tab_state().unwrap().workspaces["/p"];
        assert_eq!(saved.order, ["agent:b2", "agent:a3", "terminal:a:1", "agent:a1", "agent:b1"], "a key listed twice is kept once");
        assert_eq!(saved.pinned, ["agent:b2"]);
        assert_eq!(saved.titles["browser:p1"], "Docs");

        // Saving the same order again moves nothing.
        assert!(set_tab_layout("/p", saved.clone()).unwrap().is_empty());
        // An empty layout forgets the workspace.
        set_tab_layout("/p", TabLayout::default()).unwrap();
        assert!(tab_state().unwrap().workspaces.is_empty());
        assert_eq!(tab_ids("a"), ["a3", "a1", "a2"], "the sessions keep the order they were given");
    }

    #[test]
    fn writing_sessions_keeps_the_layouts_and_an_untouched_index_gains_no_field() {
        let _home = crate::store::temp_home();
        save(&[entry("a")]).unwrap();
        let text = std::fs::read_to_string(file_path().unwrap()).unwrap();
        assert!(!text.contains("workspaceTabs") && !text.contains("closedTabs"));

        set_tab_layout("/p", layout(&["agent:t1"])).unwrap();
        // Every other write of the index goes through these two.
        save(&[entry("a"), entry("b")]).unwrap();
        update_session("a", |s| {
            s.title = "renamed".into();
            Ok(())
        })
        .unwrap();
        assert_eq!(tab_state().unwrap().workspaces["/p"].order, ["agent:t1"]);
        assert_eq!(load().unwrap().len(), 2);
    }

    #[test]
    fn a_layout_field_a_newer_build_wrote_survives() {
        let _home = crate::store::temp_home();
        let raw = r#"{"sessions":[],"futureTop":1,"workspaceTabs":{"/p":{"order":["agent:t1"],"groups":[["agent:t1"]]}}}"#;
        std::fs::write(file_path().unwrap(), raw).unwrap();
        save(&[entry("a")]).unwrap();
        let stored: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file_path().unwrap()).unwrap()).unwrap();
        assert_eq!(stored["futureTop"], 1);
        assert_eq!(stored["workspaceTabs"]["/p"]["groups"][0][0], "agent:t1");
    }

    #[test]
    fn shell_tabs_are_forgotten_when_the_app_starts() {
        let _home = crate::store::temp_home();
        save(&[entry("a")]).unwrap();
        let mut mixed = layout(&["terminal:a:1", "agent:t1", "browser:p1"]);
        mixed.pinned = vec!["terminal:a:1".into(), "browser:p1".into()];
        mixed.muted = vec!["terminal:a:1".into()];
        mixed.titles.insert("terminal:a:1".into(), "server".into());
        set_tab_layout("/p", mixed).unwrap();
        set_tab_layout("/q", layout(&["terminal:b:1"])).unwrap();

        forget_shell_tabs().unwrap();

        let state = tab_state().unwrap();
        let kept = &state.workspaces["/p"];
        assert_eq!(kept.order, ["agent:t1", "browser:p1"]);
        assert_eq!(kept.pinned, ["browser:p1"]);
        assert!(kept.muted.is_empty() && kept.titles.is_empty());
        assert!(!state.workspaces.contains_key("/q"), "a layout of shells alone is gone");
    }

    /// A shell an agent is started in becomes that agent's tab (#437), and
    /// what the reader arranged for the shell goes with it.
    #[test]
    fn a_shell_that_became_a_tab_keeps_its_place_pin_mute_and_title() {
        let _home = crate::store::temp_home();
        save(&[entry("a")]).unwrap();
        let mut arranged = layout(&["agent:t1", "terminal:a:1", "browser:p1", "terminal:a:2"]);
        arranged.pinned = vec!["terminal:a:1".into()];
        arranged.muted = vec!["terminal:a:1".into()];
        arranged.titles.insert("terminal:a:1".into(), "dev server".into());
        set_tab_layout("/p", arranged).unwrap();
        set_tab_layout("/q", layout(&["terminal:b:1"])).unwrap();

        assert!(shell_became_tab("a:1", "typed").unwrap());

        let state = tab_state().unwrap();
        let now = &state.workspaces["/p"];
        assert_eq!(now.order, ["agent:t1", "agent:typed", "browser:p1", "terminal:a:2"]);
        assert_eq!(now.pinned, ["agent:typed"]);
        assert_eq!(now.muted, ["agent:typed"]);
        assert_eq!(now.titles.get("agent:typed").map(String::as_str), Some("dev server"));
        assert!(!now.titles.contains_key("terminal:a:1"));
        assert_eq!(state.workspaces["/q"].order, ["terminal:b:1"], "another workspace's shells are not touched");
        // The app starts again: the other shells are forgotten, and the tab is still where the shell stood.
        forget_shell_tabs().unwrap();
        assert_eq!(tab_state().unwrap().workspaces["/p"].order, ["agent:t1", "agent:typed", "browser:p1"]);
        // A shell no layout names changes nothing, and a layout that already names the tab keeps its own word.
        assert!(!shell_became_tab("a:9", "other").unwrap());
        let mut both = layout(&["agent:typed", "terminal:a:3"]);
        both.titles.insert("agent:typed".into(), "mine".into());
        both.titles.insert("terminal:a:3".into(), "older".into());
        set_tab_layout("/p", both).unwrap();
        assert!(shell_became_tab("a:3", "typed").unwrap());
        let now = &tab_state().unwrap().workspaces["/p"];
        assert_eq!(now.order, ["agent:typed"]);
        assert_eq!(now.titles.get("agent:typed").map(String::as_str), Some("mine"));
    }

    /// The pane a tab lived in is killed when the tab is closed (#437): it
    /// comes back in a pane of its own, with its conversation for the app to
    /// resume, and one that was a terminal is still a terminal.
    #[test]
    fn a_reopened_tab_does_not_come_back_to_the_pane_it_lived_in() {
        let _home = crate::store::temp_home();
        let mut a = entry("a");
        let mut typed = tab("typed");
        typed.follow = Follow { front: Front::ByHand, pane: Some("a:1".into()), title_pinned: true, ..Default::default() };
        let mut shell = tab("shell");
        shell.follow = Follow { front: Front::Terminal, pane: Some("a:2".into()), terminal_title: Some("Terminal 2".into()), ..Default::default() };
        a.tabs = vec![typed, shell, tab("t3")];
        save(&[a]).unwrap();

        close_tab("a", "typed", true).unwrap();
        close_tab("a", "shell", true).unwrap();
        let typed = reopen_tab("a", "typed").unwrap();
        assert_eq!((typed.follow.front, typed.follow.pane.as_deref(), typed.follow.title_pinned), (Front::Agent, None, true));
        assert_eq!(typed.pane_id(), "tab:typed");
        let shell = reopen_tab("a", "shell").unwrap();
        assert_eq!((shell.follow.front, shell.follow.pane.as_deref(), shell.follow.terminal_title.as_deref()), (Front::Terminal, None, Some("Terminal 2")));
        assert_eq!(get("a").unwrap().tab("typed").unwrap().follow.pane, None);
    }

    #[test]
    fn a_closed_tab_is_kept_and_comes_back_as_it_was() {
        let _home = crate::store::temp_home();
        let mut a = entry("a");
        let mut talked = tab("t1");
        talked.provider_session_id = Some("conversation".into());
        talked.title = Some("Fix login".into());
        talked.status = TabStatus::Completed;
        a.tabs = vec![talked, tab("t2")];
        a.active_tab = Some("t1".into());
        save(&[a]).unwrap();

        assert!(close_tab("a", "t1", true).unwrap().is_empty(), "nothing of a kept tab is deleted");
        let session = get("a").unwrap();
        assert_eq!(tab_ids("a"), ["t2"]);
        assert_eq!(session.active_tab.as_deref(), Some("t2"));
        let closed = tab_state().unwrap().closed;
        assert_eq!(closed.len(), 1);
        assert_eq!((closed[0].session_id.as_str(), closed[0].tab.id.as_str()), ("a", "t1"));

        let back = reopen_tab("a", "t1").unwrap();
        assert_eq!(back.provider_session_id.as_deref(), Some("conversation"));
        assert_eq!(back.title.as_deref(), Some("Fix login"));
        assert_eq!(back.status, TabStatus::Idle);
        let session = get("a").unwrap();
        assert_eq!(tab_ids("a"), ["t2", "t1"]);
        assert_eq!(session.active_tab.as_deref(), Some("t1"));
        assert!(tab_state().unwrap().closed.is_empty());
        assert!(reopen_tab("a", "t1").is_err(), "it can be reopened once");

        // A tab with nothing to bring back is simply removed, and says so.
        assert_eq!(close_tab("a", "t2", false).unwrap(), [("a".to_string(), "t2".to_string())]);
        assert!(tab_state().unwrap().closed.is_empty());
        // Closing a tab that is already gone is not an error.
        assert!(close_tab("a", "t2", true).unwrap().is_empty());
    }

    #[test]
    fn a_session_keeps_its_last_closed_tabs_and_they_go_with_it() {
        let _home = crate::store::temp_home();
        let (mut a, mut b) = (entry("a"), entry("b"));
        a.tabs = (0..CLOSED_TABS_KEPT + 2).map(|n| tab(&format!("a{n}"))).collect();
        b.tabs = vec![tab("b0")];
        save(&[a, b]).unwrap();
        close_tab("b", "b0", true).unwrap();

        let mut dropped = Vec::new();
        for n in 0..CLOSED_TABS_KEPT + 2 {
            dropped.extend(close_tab("a", &format!("a{n}"), true).unwrap());
        }
        // The two oldest of this session made room; another session's is not touched.
        assert_eq!(dropped, [("a".to_string(), "a0".to_string()), ("a".to_string(), "a1".to_string())]);
        let closed = tab_state().unwrap().closed;
        assert_eq!(closed.iter().filter(|c| c.session_id == "a").count(), CLOSED_TABS_KEPT);
        assert!(closed.iter().any(|c| c.session_id == "b"));

        update(|sessions| {
            sessions.retain(|s| s.id != "a");
            Ok(())
        })
        .unwrap();
        let closed = tab_state().unwrap().closed;
        assert_eq!(closed.iter().map(|c| c.session_id.as_str()).collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let _home = crate::store::temp_home();
        let raw = r#"{"sessions":[{"id":"a","projectPath":"/p","cwd":"/p","title":"t","created":"x","modified":"y","futureField":{"deep":true},"tabs":[{"id":"t1","harness":"claude","created":"x","extra":1}]}]}"#;
        std::fs::write(file_path().unwrap(), raw).unwrap();
        let loaded = load().unwrap();
        assert_eq!(loaded[0].unknown["futureField"]["deep"], true);
        assert_eq!(loaded[0].tabs[0].unknown["extra"], 1);
        save(&loaded).unwrap();
        let text = std::fs::read_to_string(file_path().unwrap()).unwrap();
        assert!(text.contains("futureField"));
        assert!(text.contains("\"extra\": 1"));
    }

    #[test]
    fn tabs_without_a_permission_mode_use_the_product_default() {
        let tab: TabEntry = serde_json::from_value(serde_json::json!({
            "id": "t1",
            "harness": "claude",
            "created": "x"
        }))
        .unwrap();

        assert_eq!(tab.permission_mode, DEFAULT_PERMISSION_MODE);

        // Blank or null is no mode either; a named one is kept as it is.
        for (stored, expected) in [(serde_json::json!(""), DEFAULT_PERMISSION_MODE), (serde_json::Value::Null, DEFAULT_PERMISSION_MODE), (serde_json::json!("manual"), "manual"), (serde_json::json!("plan"), "plan")] {
            let tab: TabEntry = serde_json::from_value(serde_json::json!({"id": "t1", "harness": "claude", "created": "x", "permissionMode": stored})).unwrap();
            assert_eq!(tab.permission_mode, expected);
        }
        assert_eq!(permission_mode_or_default(None), "bypassPermissions");
        assert_eq!(permission_mode_or_default(Some("  ")), "bypassPermissions");
        assert_eq!(permission_mode_or_default(Some("acceptEdits")), "acceptEdits");
        assert_eq!(requested_mode(Some(" ".into())), None);
        assert_eq!(requested_mode(None), None);
        assert_eq!(requested_mode(Some("plan".into())), Some("plan".into()));
    }

    #[test]
    fn a_tab_that_only_ever_ran_its_own_agent_is_written_as_before_and_what_it_follows_round_trips() {
        let plain: TabEntry = serde_json::from_value(serde_json::json!({ "id": "t1", "harness": "claude", "created": "x" })).unwrap();
        assert_eq!(plain.follow, Follow::default());
        assert_eq!(plain.pane_id(), "tab:t1");
        let written = serde_json::to_value(&plain).unwrap();
        for field in ["front", "pane", "terminalTitle", "titlePinned", "conversation", "adopted", "history"] {
            assert!(written.get(field).is_none(), "{field} was written for a tab that follows nothing");
        }

        let mut followed = plain.clone();
        followed.provider_session_id = Some("first".into());
        followed.follow.history.push(followed.past());
        followed.follow = Follow { front: Front::ByHand, pane: Some("s1:a".into()), terminal_title: Some("Terminal 2".into()), title_pinned: true, conversation: Some("c2".into()), adopted: true, history: followed.follow.history };
        assert_eq!(followed.pane_id(), "s1:a");
        let written = serde_json::to_value(&followed).unwrap();
        assert_eq!((written["front"].as_str(), written["pane"].as_str(), written["conversation"].as_str()), (Some("by_hand"), Some("s1:a"), Some("c2")));
        assert_eq!(written["history"][0]["providerSessionId"], "first");
        // The first conversation has no id of its own: its events are the unmarked ones.
        assert!(written["history"][0].get("id").is_none());
        assert_eq!(serde_json::from_value::<TabEntry>(written).unwrap(), followed);
        followed.provider_session_id = Some("second".into());
        assert_eq!(followed.conversations().collect::<Vec<_>>(), [("claude", "second", true), ("claude", "first", false)]);

        // A front this build has never heard of is an ordinary agent tab, not a lost index.
        let newer: TabEntry = serde_json::from_value(serde_json::json!({ "id": "t1", "harness": "claude", "created": "x", "front": "hologram" })).unwrap();
        assert_eq!(newer.follow.front, Front::Agent);
    }

    #[test]
    fn a_quick_chat_is_stored_with_its_kind_and_an_ordinary_session_is_written_as_before() {
        let _home = crate::store::temp_home();
        let mut quick = entry("quick");
        quick.kind = SessionKind::Quick;
        quick.project_path = "/home/.raccoon/quick/quick".into();
        quick.cwd = quick.project_path.clone();
        save(&[entry("ordinary"), quick.clone()]).unwrap();

        let stored: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file_path().unwrap()).unwrap()).unwrap();
        // An ordinary entry gains no field, so nothing changes for it on disk.
        assert!(stored["sessions"][0].get("kind").is_none());
        assert_eq!(stored["sessions"][1]["kind"], "quick");
        // The path an older build requires is still there, and is a real one.
        assert_eq!(stored["sessions"][1]["projectPath"], "/home/.raccoon/quick/quick");

        let loaded = load().unwrap();
        assert_eq!(loaded[0].kind, SessionKind::Project);
        assert_eq!(loaded[0].project(), Some("/p"));
        assert_eq!(loaded[1], quick);
        assert!(loaded[1].is_quick());
        assert_eq!(loaded[1].project(), None);
    }

    /// What a build from before quick chats does with the index: it has no
    /// `kind` field, requires `projectPath`, and keeps what it does not know.
    #[test]
    fn an_older_build_reads_a_quick_chat_as_a_session_and_keeps_its_kind() {
        #[derive(Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct OldEntry {
            id: String,
            project_path: String,
            cwd: String,
            title: String,
            #[serde(flatten, default)]
            unknown: BTreeMap<String, serde_json::Value>,
        }
        #[derive(Serialize, Deserialize)]
        struct OldIndex {
            sessions: Vec<OldEntry>,
        }
        let _home = crate::store::temp_home();
        let mut quick = entry("quick");
        quick.kind = SessionKind::Quick;
        save(&[quick.clone()]).unwrap();

        let text = std::fs::read_to_string(file_path().unwrap()).unwrap();
        let old: OldIndex = serde_json::from_str(&text).expect("an older build must still parse the index");
        assert_eq!(old.sessions[0].project_path, "/p");
        assert_eq!(old.sessions[0].unknown["kind"], "quick");

        // It rewrites the index (a rename, say): the session is still a quick chat afterwards.
        std::fs::write(file_path().unwrap(), serde_json::to_string(&old).unwrap()).unwrap();
        assert_eq!(load().unwrap()[0].kind, SessionKind::Quick);
    }

    #[test]
    fn a_kind_this_build_does_not_know_does_not_cost_the_whole_index() {
        let _home = crate::store::temp_home();
        let raw = r#"{"sessions":[{"id":"a","kind":"hologram","projectPath":"/p","cwd":"/p","title":"t","created":"x","modified":"y"},{"id":"b","kind":null,"projectPath":"/p","cwd":"/p","title":"t","created":"x","modified":"y"}]}"#;
        std::fs::write(file_path().unwrap(), raw).unwrap();
        let loaded = load().unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.iter().all(|session| session.kind == SessionKind::Project));
    }

    #[test]
    fn a_quick_chat_whose_borrowed_workspace_is_removed_goes_back_to_no_branch() {
        let mut session = entry("quick");
        session.kind = SessionKind::Quick;
        session.project_path = "/home/.raccoon/quick/quick".into();
        session.cwd = "/p/.raccoon/worktrees/feature-one".into();
        session.branch = Some("raccoon/feature-one".into());
        mark_workspace_removed(&mut session, Some("main".into()));
        assert_eq!(session.cwd, "/home/.raccoon/quick/quick");
        assert_eq!(session.branch, None);
    }

    #[test]
    fn update_session_touches_modified() {
        let _home = crate::store::temp_home();
        save(&[entry("a")]).unwrap();
        update_session("a", |s| {
            s.title = "renamed".into();
            Ok(())
        })
        .unwrap();
        assert_eq!(get("a").unwrap().title, "renamed");
        assert!(get("zzz").is_err());
    }

    #[test]
    fn removed_workspace_transition_preserves_provenance_and_transcripts() {
        let mut session = entry("removed");
        session.cwd = "/p/.raccoon/worktrees/feature-one".into();
        session.worktree_name = Some("feature-one".into());
        session.branch = Some("raccoon/feature-one".into());
        session.base_ref = Some("base-sha".into());
        session.tabs.push(TabEntry {
            id: "tab-one".into(),
            harness: "codex".into(),
            title: None,
            model: "gpt-5".into(),
            effort: None, requested_model: None, requested_effort: None, requested_permission_mode: None,
            permission_mode: DEFAULT_PERMISSION_MODE.into(),
            provider_session_id: Some("provider-session".into()),
            status: TabStatus::InProgress,
            created: "now".into(),
            modified: "now".into(),
            context_used: None,
            context_max: None,
            fork_from: None,
            follow: Follow::default(),
            unknown: BTreeMap::new(),
        });

        mark_workspace_removed(&mut session, Some("main".into()));

        assert_eq!(session.cwd, "/p");
        assert_eq!(session.branch.as_deref(), Some("main"));
        assert_eq!(session.worktree_name, None);
        assert!(session.worktree_removed);
        assert_eq!(session.tabs.len(), 1);
        assert_eq!(
            session.tabs[0].provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(session.tabs[0].status, TabStatus::Idle);
        assert_eq!(
            session.removed_workspace,
            Some(RemovedWorkspace {
                path: "/p/.raccoon/worktrees/feature-one".into(),
                name: "feature-one".into(),
                branch: Some("raccoon/feature-one".into()),
            })
        );
        assert!(claimed_worktree_names(&[session]).is_empty());
    }

    #[test]
    fn removed_workspace_transition_names_sessions_opened_in_an_existing_checkout() {
        let mut session = entry("external");
        session.cwd = "/worktrees/existing-feature".into();
        session.branch = Some("feature/existing".into());

        mark_workspace_removed(&mut session, Some("main".into()));

        assert_eq!(
            session.removed_workspace,
            Some(RemovedWorkspace {
                path: "/worktrees/existing-feature".into(),
                name: "existing-feature".into(),
                branch: Some("feature/existing".into()),
            })
        );
    }
}
