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
    pub unknown: BTreeMap<String, serde_json::Value>,
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
    /// Set when the session was started from a tracker issue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<IssueRef>,
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

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexFile {
    #[serde(default)]
    sessions: Vec<SessionEntry>,
}

fn file_path() -> Result<PathBuf> {
    Ok(super::sessions_dir()?.join("index.json"))
}

pub fn load() -> Result<Vec<SessionEntry>> {
    Ok(super::read_json::<IndexFile>(&file_path()?)?.unwrap_or_default().sessions)
}

pub fn save(sessions: &[SessionEntry]) -> Result<()> {
    super::write_json(&file_path()?, &IndexFile { sessions: sessions.to_vec() })
}

/// Apply `f` to the whole index under the write lock and persist it.
pub fn update<R>(f: impl FnOnce(&mut Vec<SessionEntry>) -> Result<R>) -> Result<R> {
    let mut sessions = load()?;
    let r = f(&mut sessions)?;
    save(&sessions)?;
    Ok(r)
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
            automation: None,
            title: "t".into(),
            created: now(),
            modified: now(),
            archived: false,
            pinned: false,
            tabs: vec![],
            active_tab: None,
            unknown: BTreeMap::new(),
        }
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
