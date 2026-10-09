//! Session index operations shared by the Tauri commands, the control socket
//! and the headless runtime: creating a session (and its worktree) and telling
//! listeners when sessions or workspaces go away.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::sink::EventSink;
use crate::store::index::{self, AutomationRef, IssueRef, SessionEntry, SessionKind, TabEntry, TabStatus};
use crate::store::projects;
use crate::{git, names, store};

type Result<T> = std::result::Result<T, String>;

/// Serialize name selection with creation/rename so two app requests cannot
/// claim the same name between checking it and saving the session index.
static WORKSPACE_NAMING: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkspaceError {
    #[error("{0}")]
    InvalidArguments(String),
    #[error("{0}")]
    Operation(String),
}

impl From<String> for WorkspaceError {
    fn from(message: String) -> Self {
        Self::Operation(message)
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

pub(crate) const WORKSPACES_CHANGED_EVENT: &str = "workspaces_changed";
pub(crate) const SESSION_DELETED_EVENT: &str = "session_deleted";
/// A request to show, hide or toggle the desktop app's floating chat window,
/// from the command line. The desktop app listens; nothing else does.
pub(crate) const FLOATING_REQUEST_EVENT: &str = "floating_window_request";

/// Tell the frontend a workspace is gone: its sessions were removed outright,
/// so each goes out as a deletion rather than an update.
pub(crate) fn notify_workspace_deleted(sink: &dyn EventSink, project_path: &str, removed: &[SessionEntry]) {
    notify_sessions_deleted(sink, removed);
    sink.emit(WORKSPACES_CHANGED_EVENT, project_path);
}

/// Sessions that a workspace still on disk stops hosting: settling a worktree
/// keeps the session alive at the project root, so these go out as updates.
pub(crate) fn notify_workspace_settled(sink: &dyn EventSink, project_path: &str, moved: &[SessionEntry]) {
    for session in moved {
        sink.emit("session_updated", session);
    }
    sink.emit(WORKSPACES_CHANGED_EVENT, project_path);
}

pub(crate) fn notify_sessions_deleted(sink: &dyn EventSink, removed: &[SessionEntry]) {
    for session in removed {
        sink.emit(SESSION_DELETED_EVENT, &session.id);
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTab {
    pub harness: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub project_path: String,
    #[serde(default)]
    pub title: Option<String>,
    pub use_worktree: bool,
    #[serde(default)]
    pub base_ref: Option<String>,
    /// A requested worktree name (an issue slug); sanitised and made unique.
    #[serde(default)]
    pub worktree_name: Option<String>,
    /// Explicit acknowledgement that a requested worktree should be skipped.
    #[serde(default)]
    pub on_main: bool,
    #[serde(default)]
    pub issue: Option<IssueRef>,
    #[serde(default)]
    pub automation: Option<AutomationRef>,
    /// An existing workspace to run in instead of a new worktree.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The first agent conversation. Omitted when a checkout is opened directly.
    #[serde(default)]
    pub tab: Option<NewTab>,
}

pub(crate) fn validate_session_target(req: &NewSession) -> Result<()> {
    let requested_worktree = req.worktree_name.as_deref().is_some_and(|name| !name.trim().is_empty());
    if !req.use_worktree && requested_worktree && !req.on_main {
        return Err("A requested worktree can only be skipped when onMain is explicitly true.".into());
    }
    Ok(())
}

pub(crate) fn available_worktree_name(project: &Path, requested: Option<&str>, excluding: Option<&str>) -> Result<String> {
    let mut taken = taken_worktree_names(project)?;
    if let Some(excluding) = excluding {
        taken.retain(|name| name != excluding);
    }
    match requested.filter(|name| !name.trim().is_empty()) {
        Some(requested) => names::requested(requested, &taken)
            .ok_or_else(|| "Workspace names must contain at least one letter or number.".into()),
        None => Ok(names::unclaimed(&taken)),
    }
}

fn taken_worktree_names(project: &Path) -> Result<Vec<String>> {
    let sessions = index::load().map_err(err)?.into_iter()
        .filter(|session| Path::new(&session.project_path) == project)
        .collect::<Vec<_>>();
    Ok(git::taken_worktree_names(project, &index::claimed_worktree_names(&sessions)))
}

/// Use the same slug rules as the workspace UI, but never silently suffix an
/// explicit name. Generated defaults continue to use `available_worktree_name`.
fn requested_worktree_name(project: &Path, requested: &str, excluding: Option<&str>) -> std::result::Result<String, WorkspaceError> {
    let name = names::requested(requested, &[]).ok_or_else(|| WorkspaceError::InvalidArguments(
        "Workspace names must contain at least one ASCII letter or number.".into(),
    ))?;
    if excluding != Some(name.as_str())
        && (taken_worktree_names(project)?.contains(&name) || git::worktree_path(project, &name).symlink_metadata().is_ok())
    {
        return Err(WorkspaceError::InvalidArguments(format!("Workspace name '{name}' is already taken; choose another name.")));
    }
    Ok(name)
}

pub(crate) fn new_tab_entry(t: &NewTab) -> TabEntry {
    TabEntry {
        id: uuid::Uuid::now_v7().to_string(),
        harness: t.harness.clone(),
        title: None,
        model: t.model.clone(),
        effort: t.effort.clone(),
        permission_mode: index::permission_mode_or_default(t.permission_mode.as_deref()),
        provider_session_id: None,
        status: TabStatus::Idle,
        created: index::now(),
        modified: index::now(),
        context_used: None,
        context_max: None,
        fork_from: None,
        unknown: BTreeMap::new(),
    }
}

/// Create a session: an index entry around an existing checkout, or a new
/// worktree and its first tab. The index entry lands before anything else can
/// fail after it, so a session whose agent never starts is still visible and
/// deletable.
pub(crate) fn create_session_blocking(sink: &dyn EventSink, req: NewSession) -> Result<SessionEntry> {
    let entry = create_session_entry(req)?;
    sink.emit("session_created", &entry);
    Ok(entry)
}

pub(crate) fn create_session_entry(req: NewSession) -> Result<SessionEntry> {
    create_session_entry_with_name(req, None).map_err(err)
}

/// CLI creation keeps an explicit `--name` distinct from the automatically
/// uniquified worktree-name hints used by the issue view and automations.
pub(crate) fn create_named_session_blocking(sink: &dyn EventSink, req: NewSession, name: Option<&str>) -> std::result::Result<SessionEntry, WorkspaceError> {
    let entry = create_session_entry_with_name(req, name)?;
    sink.emit("session_created", &entry);
    Ok(entry)
}

fn create_session_entry_with_name(req: NewSession, name: Option<&str>) -> std::result::Result<SessionEntry, WorkspaceError> {
    let _naming = WORKSPACE_NAMING.lock();
    validate_session_target(&req)?;
    let project = projects::canonical_directory(&req.project_path).map_err(err)?;
    projects::refuse_mirror(&project).map_err(err)?;
    let project_path = Path::new(&project);
    let id = uuid::Uuid::now_v7().to_string();
    let now = index::now();
    let requested_title = req.title.clone().filter(|t| !t.trim().is_empty())
        .or_else(|| req.issue.as_ref().map(|issue| format!("{} {}", issue.identifier, issue.title)));
    let first_tab = req.tab.as_ref().map(new_tab_entry);
    let has_agent = first_tab.is_some();
    let explicit_name = name.map(|name| {
        if !has_agent || !req.use_worktree || req.on_main || req.cwd.is_some() || !git::is_repo(project_path) {
            return Err(WorkspaceError::InvalidArguments("--name requires a new worktree in a Git project.".into()));
        }
        requested_worktree_name(project_path, name, None)
    }).transpose()?;

    let mut entry = SessionEntry {
        id: id.clone(),
        kind: SessionKind::Project,
        project_path: project.clone(),
        cwd: project.clone(),
        worktree_name: None,
        branch: git::current_branch(project_path),
        base_ref: None,
        worktree_base: None,
        worktree_removed: false,
        removed_workspace: None,
        issue: req.issue.clone(),
        automation: req.automation.clone(),
        title: String::new(),
        created: now.clone(),
        modified: now,
        archived: false,
        pinned: false,
        active_tab: first_tab.as_ref().map(|tab| tab.id.clone()),
        tabs: first_tab.into_iter().collect(),
        unknown: BTreeMap::new(),
    };

    if let Some(cwd) = req.cwd.as_deref().filter(|c| !c.is_empty()) {
        let cwd = projects::canonical_directory(cwd).map_err(err)?;
        projects::refuse_mirror(&cwd).map_err(err)?;
        entry.branch = git::current_branch(Path::new(&cwd));
        entry.cwd = cwd;
    } else if has_agent && req.use_worktree && git::is_repo(project_path) {
        let issue_name = req.issue.as_ref().map(|issue| format!("{} {}", issue.identifier, issue.title));
        // A title with no ASCII letters/numbers is still a valid title.
        let title_name = requested_title.as_deref().filter(|name| names::requested(name, &[]).is_some());
        let generated_name = req.worktree_name.as_deref().or(issue_name.as_deref()).or(title_name);
        let name = match explicit_name {
            Some(name) => name,
            None => available_worktree_name(project_path, generated_name, None)?,
        };
        let wt = git::create_worktree(project_path, &name, req.base_ref.as_deref()).map_err(err)?;
        entry.cwd = wt.path;
        entry.worktree_name = Some(wt.name);
        entry.branch = Some(wt.branch);
        entry.base_ref = Some(wt.base_tree);
        entry.worktree_base = wt.worktree_base;
    }

    entry.title = requested_title.unwrap_or_else(|| {
        if has_agent {
            "New session".into()
        } else {
            entry.branch.clone().unwrap_or_else(|| projects::project_name(&entry.cwd))
        }
    });

    index::update(|sessions| {
        sessions.push(entry.clone());
        Ok(())
    })
    .map_err(err)?;
    Ok(entry)
}

/// A quick chat to create: a session with no project, and so no worktree,
/// branch or base.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewQuickChat {
    #[serde(default)]
    pub title: Option<String>,
    /// A folder to run in instead of the scratch directory. It is used as it
    /// is: it does not become a project.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The first agent conversation. Omitted for a quick chat that starts as
    /// a terminal.
    #[serde(default)]
    pub tab: Option<NewTab>,
}

pub(crate) const QUICK_CHAT_TITLE: &str = "Quick chat";

/// A folder a quick chat is asked to run in: it must exist, and must not be
/// a read-only mirror of a cloud workspace.
fn quick_chat_folder(path: &str) -> Result<String> {
    let folder = projects::canonical_directory(path).map_err(err)?;
    projects::refuse_mirror(&folder).map_err(err)?;
    Ok(folder)
}

/// Create a quick chat and tell listeners. Like any session, its index entry
/// is written before an agent is started in it.
pub(crate) fn create_quick_chat_blocking(sink: &dyn EventSink, req: NewQuickChat) -> Result<SessionEntry> {
    let entry = create_quick_chat_entry(req)?;
    sink.emit("session_created", &entry);
    Ok(entry)
}

pub(crate) fn create_quick_chat_entry(req: NewQuickChat) -> Result<SessionEntry> {
    let id = uuid::Uuid::now_v7().to_string();
    let scratch = store::quick::create(&id).map_err(err)?;
    let created = (|| {
        let chosen = req.cwd.as_deref().filter(|cwd| !cwd.trim().is_empty()).map(quick_chat_folder).transpose()?;
        let first_tab = req.tab.as_ref().map(new_tab_entry);
        let now = index::now();
        let entry = SessionEntry {
            id: id.clone(),
            kind: SessionKind::Quick,
            project_path: scratch.clone(),
            // The scratch directory is on no branch even when the TerminalX
            // home happens to sit inside a repository (dotfiles kept in git).
            branch: chosen.as_deref().and_then(|cwd| git::current_branch(Path::new(cwd))),
            cwd: chosen.unwrap_or_else(|| scratch.clone()),
            worktree_name: None,
            base_ref: None,
            worktree_base: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: None,
            automation: None,
            title: req.title.clone().filter(|title| !title.trim().is_empty()).unwrap_or_else(|| QUICK_CHAT_TITLE.into()),
            created: now.clone(),
            modified: now,
            archived: false,
            pinned: false,
            active_tab: first_tab.as_ref().map(|tab| tab.id.clone()),
            tabs: first_tab.into_iter().collect(),
            unknown: BTreeMap::new(),
        };
        index::update(|sessions| {
            sessions.push(entry.clone());
            Ok(())
        })
        .map_err(err)?;
        Ok(entry)
    })();
    // No session came of it: its directory is not left behind.
    if created.is_err() {
        let _ = store::quick::remove(&id);
    }
    created
}

/// What a quick chat's scratch directory holds, for the confirmation shown
/// before it is deleted.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuickChatScratch {
    pub path: String,
    /// Files in it, counted no further than [`SCRATCH_COUNT_LIMIT`].
    pub files: usize,
    /// The count stopped at the limit: there are at least this many.
    pub more: bool,
    /// The session runs there now, rather than in a folder it was pointed at.
    pub in_use: bool,
}

pub(crate) const SCRATCH_COUNT_LIMIT: usize = 1000;

pub(crate) fn quick_chat_scratch(session_id: &str) -> Result<QuickChatScratch> {
    let entry = index::get(session_id).map_err(err)?;
    let path = store::quick::dir(&entry.id).map_err(err)?;
    let files = store::quick::file_count(&entry.id, SCRATCH_COUNT_LIMIT);
    Ok(QuickChatScratch {
        path: path.to_string_lossy().into_owned(),
        files,
        more: files >= SCRATCH_COUNT_LIMIT,
        in_use: entry.is_quick() && store::quick::is_scratch(&entry.id, &entry.cwd),
    })
}

fn quick_chat(session_id: &str) -> Result<SessionEntry> {
    let entry = index::get(session_id).map_err(err)?;
    if !entry.is_quick() {
        return Err("This session belongs to a project. Only a quick chat can be pointed at another folder or moved into a project.".into());
    }
    Ok(entry)
}

/// The agents key what they keep on the directory a conversation runs in.
/// Before a session's tabs start again somewhere unrelated, put what can be
/// carried where the CLI will look, so the same conversation resumes. Claude
/// Code files a transcript under its directory's name; Codex finds a rollout
/// by id wherever it runs. A tab whose conversation cannot be carried still
/// has its history here, and can be continued with a handoff.
fn carry_conversations(entry: &SessionEntry, to: &str) {
    let Some(projects) = crate::agent_data::claude_projects_root() else { return };
    for tab in entry.tabs.iter().filter(|tab| tab.harness == "claude") {
        // A fork that has not started yet has no conversation of its own: its
        // CLI will reopen the parent's from the new directory, so a copy of
        // that goes along. The parent's own stays where the parent uses it.
        let (id, keep_source) = match (tab.provider_session_id.as_deref(), tab.fork_from.as_deref()) {
            (Some(own), _) => (own, false),
            (None, Some(parent)) => (parent, true),
            (None, None) => continue,
        };
        if let Err(error) = crate::harness::claude::transcript::rehome_in(&projects, &entry.cwd, to, id, keep_source) {
            log::warn!("carry the conversation of tab {} to its new directory: {error}", tab.id);
        }
    }
}

/// Run a quick chat in `cwd` from now on, or in its scratch directory again
/// when `cwd` is `None`. The folder is used as it is and is not registered as
/// a project. `stop` ends what the session's tabs run: they start again, in
/// the new directory, the next time they are opened.
pub(crate) fn set_quick_chat_cwd(sink: &dyn EventSink, session_id: &str, cwd: Option<&str>, stop: &dyn Fn(&SessionEntry)) -> Result<SessionEntry> {
    let entry = quick_chat(session_id)?;
    let target = match cwd.filter(|cwd| !cwd.trim().is_empty()) {
        Some(cwd) => quick_chat_folder(cwd)?,
        None => store::quick::create(&entry.id).map_err(err)?,
    };
    if target == entry.cwd {
        return Ok(entry);
    }
    let scratch = store::quick::is_scratch(&entry.id, &target);
    stop(&entry);
    carry_conversations(&entry, &target);
    let branch = if scratch { None } else { git::current_branch(Path::new(&target)) };
    let updated = index::update_session(session_id, |session| {
        session.cwd = target.clone();
        session.branch = branch.clone();
        session.worktree_name = None;
        session.worktree_removed = false;
        session.removed_workspace = None;
        session.base_ref = None;
        session.worktree_base = None;
        for tab in &mut session.tabs {
            tab.status = TabStatus::Idle;
        }
        Ok(session.clone())
    })
    .map_err(err)?;
    sink.emit("session_updated", &updated);
    Ok(updated)
}

/// Turn a quick chat into an ordinary session of `project_path`, keeping its
/// tabs and their history. The project is added if the reader has not
/// attached it yet. An empty scratch directory goes; one that holds files is
/// kept until the session is deleted, since the conversation may refer to
/// them.
pub(crate) fn move_quick_chat_to_project(sink: &dyn EventSink, session_id: &str, project_path: &str, stop: &dyn Fn(&SessionEntry)) -> Result<SessionEntry> {
    let entry = quick_chat(session_id)?;
    let project = projects::add(project_path).map_err(err)?.path;
    projects::refuse_mirror(&project).map_err(err)?;
    stop(&entry);
    carry_conversations(&entry, &project);
    let branch = git::current_branch(Path::new(&project));
    let updated = index::update_session(session_id, |session| {
        session.kind = SessionKind::Project;
        session.project_path = project.clone();
        session.cwd = project.clone();
        session.branch = branch.clone();
        session.worktree_name = None;
        session.worktree_removed = false;
        session.removed_workspace = None;
        session.base_ref = None;
        session.worktree_base = None;
        for tab in &mut session.tabs {
            tab.status = TabStatus::Idle;
        }
        Ok(session.clone())
    })
    .map_err(err)?;
    store::quick::remove_if_empty(&entry.id);
    sink.emit("session_updated", &updated);
    sink.emit(WORKSPACES_CHANGED_EVENT, &project);
    Ok(updated)
}

/// Delete quick chats nobody has touched for `days` days, with their scratch
/// directories. A pinned or archived one is kept (the reader set it aside on
/// purpose), and so is one `busy` says is running. `stop` ends what an idle
/// one still has open. Returns what was deleted.
pub(crate) fn sweep_idle_quick_chats(sink: &dyn EventSink, days: u32, busy: &dyn Fn(&SessionEntry) -> bool, stop: &dyn Fn(&SessionEntry)) -> Result<Vec<SessionEntry>> {
    if days == 0 {
        return Ok(Vec::new());
    }
    let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(days));
    let idle = |session: &SessionEntry| {
        let working = session.tabs.iter().any(|tab| matches!(tab.status, TabStatus::InProgress | TabStatus::Waiting));
        // A date that cannot be read is not a reason to delete.
        let last = chrono::DateTime::parse_from_rfc3339(&session.modified).ok();
        session.is_quick() && !session.pinned && !session.archived && !working && last.is_some_and(|last| last < cutoff)
    };
    let doomed: Vec<SessionEntry> = index::load().map_err(err)?.into_iter().filter(|session| idle(session) && !busy(session)).collect();
    for session in &doomed {
        stop(session);
    }
    remove_session_entries(&doomed)?;
    notify_sessions_deleted(sink, &doomed);
    Ok(doomed)
}

/// Remove scratch directories that belong to no session and were last
/// touched more than `older_than` ago. Returns how many went. Nothing goes
/// when the index cannot be read: without it there is no telling whose they are.
pub(crate) fn remove_orphan_scratch(older_than: std::time::Duration) -> usize {
    let Ok(sessions) = index::load() else { return 0 };
    // No sessions at all is also what a missing or unreadable-as-empty index
    // looks like. Every directory would then be an orphan; none is removed.
    if sessions.is_empty() {
        return 0;
    }
    let known: std::collections::HashSet<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
    let old = |path: &Path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age >= older_than);
    store::quick::orphans(&known).into_iter().filter(|path| old(path)).filter(|path| std::fs::remove_dir_all(path).is_ok()).count()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRename {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub sessions: Vec<SessionEntry>,
}

pub(crate) fn rename_workspace_entries(project_path: &str, path: &str, requested: &str) -> std::result::Result<WorkspaceRename, WorkspaceError> {
    let _naming = WORKSPACE_NAMING.lock();
    let project = projects::canonical(project_path).map_err(err)?;
    let target = std::fs::canonicalize(path).map_err(err)?;
    let old_name = target
        .file_name()
        .and_then(|part| part.to_str())
        .ok_or_else(|| "Workspace has no usable name.".to_string())?
        .to_string();
    let name = requested_worktree_name(Path::new(&project), requested, Some(&old_name))?;
    let renamed = git::rename_worktree(Path::new(&project), &target, &name).map_err(err)?;
    let new_path = renamed.path.clone();
    let new_branch = renamed.branch.clone();
    let update = index::update(|sessions| {
        let mut affected = Vec::new();
        for session in sessions {
            // The old folder no longer exists after `git worktree move`, so
            // compare its canonical path lexically instead of canonicalising
            // the session cwd after the move.
            let matches = Path::new(&session.cwd) == target || session.cwd == path;
            if matches {
                session.cwd = new_path.clone();
                session.worktree_name = Some(name.clone());
                session.branch = Some(new_branch.clone());
                session.modified = index::now();
                affected.push(session.clone());
            }
        }
        Ok(affected)
    });
    match update {
        Ok(sessions) => Ok(WorkspaceRename { name, path: renamed.path, branch: renamed.branch, sessions }),
        Err(save_error) => {
            let rollback = git::rename_worktree(Path::new(&project), Path::new(&renamed.path), &old_name);
            match rollback {
                Ok(_) => Err(WorkspaceError::Operation(err(save_error))),
                Err(rollback_error) => Err(WorkspaceError::Operation(format!(
                    "Workspace was renamed but its session metadata could not be saved ({save_error:#}); rollback also failed ({rollback_error:#})."
                ))),
            }
        }
    }
}

pub(crate) fn sessions_in_workspace(path: &Path) -> Result<Vec<SessionEntry>> {
    index::load().map(|sessions| sessions_within(sessions, path)).map_err(err)
}

/// What deleting a workspace would cost: the git state of its tree plus the
/// sessions (and transcripts) that would go with it. The one read behind the
/// desktop's `workspace_disposition` and the runtime's `workspace.disposition`.
///
/// `fetch` is for the dialog that is about to delete the workspace, which
/// asks for it. Everything else that reads the disposition (the pull request
/// panel and the chat do so every 30 seconds) does not fetch and gets no
/// clean-and-merged verdict at all; it still asks GitHub for the branch's
/// pull request. A folder that is not on disk gets a
/// verdict too ("cannot be checked"), so the dialog can ask about it rather
/// than wave it through.
pub(crate) fn workspace_disposition(project: &Path, path: &Path, fetch: bool) -> Result<crate::workspaces::WorkspaceDisposition> {
    let mut disposition = crate::workspaces::disposition(project, path);
    if fetch && !disposition.is_main {
        disposition.landed = Some(crate::landed::check(project, path, crate::landed::Fetch::Fresh));
    }
    let sessions = sessions_in_workspace(path)?;
    disposition.sessions = sessions.len();
    disposition.session_ids = sessions.iter().map(|session| session.id.clone()).collect();
    disposition.session_titles = sessions.into_iter().map(|session| session.title).collect();
    Ok(disposition)
}

/// The sessions among `sessions` that run in the checkout at `path`.
pub(crate) fn sessions_within(sessions: Vec<SessionEntry>, path: &Path) -> Vec<SessionEntry> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    sessions
        .into_iter()
        .filter(|session| {
            let cwd = Path::new(&session.cwd);
            match std::fs::canonicalize(cwd) {
                Ok(cwd) if cwd == target => true,
                // A session started in a subdirectory belongs to the
                // checkout that directory is part of. Another
                // worktree nested below this one (the project's own
                // worktree folder is) is its own workspace.
                Ok(cwd) if cwd.starts_with(&target) => {
                    git::run(&cwd, &["rev-parse", "--show-toplevel"]).ok().and_then(|top| std::fs::canonicalize(top.trim()).ok()).is_some_and(|top| top == target)
                }
                Ok(_) => false,
                Err(_) => cwd == target,
            }
        })
        .collect()
}

/// The other sessions that would be deleted along with `session_id` when
/// its worktree is removed: every session running in the same checkout,
/// matched the way the delete itself matches them. Empty when the session
/// has no worktree to remove.
pub(crate) fn sessions_sharing_worktree(session_id: &str) -> Result<Vec<SessionEntry>> {
    let entry = index::get(session_id).map_err(err)?;
    if entry.worktree_name.is_none() || entry.worktree_removed {
        return Ok(Vec::new());
    }
    Ok(sessions_in_workspace(Path::new(&entry.cwd))?.into_iter().filter(|session| session.id != entry.id).collect())
}

/// What becomes of the sessions in a workspace that is removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionsFate {
    /// Deleting the workspace: its sessions go with it.
    Delete,
    /// Settling: the work has landed, the conversations are kept and move to
    /// the project root.
    Keep,
}

/// What the person confirmed before a workspace is removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Confirmation {
    /// One confirmation: enough only for a workspace the check finds safe.
    Single,
    /// A second confirmation, given for exactly what was shown: the digest
    /// of the check the dialog displayed. If the workspace has changed since
    /// (more to lose, or less), the digest no longer matches and nothing is
    /// removed until the person has seen the new state.
    Shown(String),
    /// A second confirmation from a caller that showed nothing: the CLI's
    /// `--force`, or a remote client's `confirmedUnsafe`.
    Forced,
}

/// A request to remove a workspace, from any entry point.
pub(crate) struct WorkspaceRemoval<'a> {
    pub project_path: &'a str,
    pub path: &'a str,
    pub sessions: SessionsFate,
    pub delete_branch: bool,
    pub confirmation: Confirmation,
    /// The sessions the person was told are in the workspace. When given,
    /// the removal is refused if the workspace holds any other set: a
    /// session added since from another window, the CLI or a remote client
    /// must not be deleted unnamed.
    pub expected_sessions: Option<&'a [String]>,
    pub direct: git::DirectDelete,
    pub fetch: crate::landed::Fetch,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct WorkspaceRemoved {
    /// The sessions that were in the workspace: deleted, or as they are now
    /// that they have moved to the project root.
    pub sessions: Vec<SessionEntry>,
    pub removal: git::WorktreeRemoval,
}

/// How an error from [`remove_workspace`] starts when the workspace was left
/// alone because it needs the second confirmation. Callers that can ask for
/// it look for this.
pub(crate) const NEEDS_CONFIRMATION: &str = "This workspace needs a second confirmation before it is removed";

/// How the error starts when the sessions in the workspace are not the ones
/// the person was shown.
pub(crate) const SESSIONS_CHANGED: &str = "The sessions in this workspace changed since it was shown";

fn permitted(landed: &crate::landed::Landed, confirmation: &Confirmation) -> bool {
    landed.safe
        || match confirmation {
            Confirmation::Single => false,
            Confirmation::Shown(digest) => *digest == landed.digest,
            Confirmation::Forced => true,
        }
}

fn needs_confirmation(landed: &crate::landed::Landed, confirmation: &Confirmation, lead: &str) -> String {
    let losses: Vec<String> = landed.losses.iter().map(|line| format!("• {line}")).collect();
    let changed = if matches!(confirmation, Confirmation::Shown(_)) { " What would be lost is not what was confirmed; this is how it stands now." } else { "" };
    format!("{NEEDS_CONFIRMATION}.{changed} {lead}\n{}", losses.join("\n"))
}

/// The one way a workspace is removed: the workspace menu, settling, the
/// session delete that takes its workspace along, the CLI and remote clients
/// all end here, so they cannot disagree about the rules.
///
/// In order:
///
/// 1. The sessions in the workspace must be the ones the caller named.
/// 2. The clean-and-merged check is made, always, at the moment of removal.
///    A workspace that is not safe needs a second confirmation, and one
///    given in a dialog counts only for the state that dialog showed.
/// 3. `stop` ends what each session runs, and waits.
/// 4. The workspace is read again. Something an agent wrote between the
///    check and its stopping must not be deleted under the earlier verdict.
/// 5. The directory is removed. On the safe path git is not forced, so it
///    refuses by itself if the tree is not clean after all.
///
/// A folder that is not on disk (removed by hand, or on a volume that is not
/// mounted) cannot be checked, so it needs the second confirmation too.
pub(crate) fn remove_workspace(sink: &dyn EventSink, request: &WorkspaceRemoval<'_>, stop: &dyn Fn(&SessionEntry)) -> Result<WorkspaceRemoved> {
    let project = std::fs::canonicalize(request.project_path).unwrap_or_else(|_| PathBuf::from(request.project_path));
    let target = std::fs::canonicalize(request.path).unwrap_or_else(|_| PathBuf::from(request.path));
    if target == project {
        return Err("A project's own checkout cannot be removed.".into());
    }
    let affected = sessions_in_workspace(&target)?;
    if let Some(expected) = request.expected_sessions {
        let now: std::collections::BTreeSet<&str> = affected.iter().map(|session| session.id.as_str()).collect();
        let shown: std::collections::BTreeSet<&str> = expected.iter().map(String::as_str).collect();
        if now != shown {
            let titles: Vec<String> = affected.iter().map(|session| format!("• {}", session.title)).collect();
            let list = if titles.is_empty() { "• (none)".to_string() } else { titles.join("\n") };
            return Err(format!("{SESSIONS_CHANGED}. Nothing was removed. It now holds:\n{list}"));
        }
    }
    let before = crate::landed::check(&project, &target, request.fetch);
    if !permitted(&before, &request.confirmation) {
        return Err(needs_confirmation(&before, &request.confirmation, "Nothing was removed."));
    }
    for session in &affected {
        stop(session);
    }
    // Read again now that nothing is running in it. The default branch was
    // fetched a moment ago, so this does not go to the network again.
    let again = if before.fresh { crate::landed::Fetch::JustFetched } else { crate::landed::Fetch::Skip };
    let after = crate::landed::check(&project, &target, again);
    if !permitted(&after, &request.confirmation) {
        return Err(needs_confirmation(&after, &request.confirmation, "It changed while its sessions were being stopped. Nothing was removed; its sessions are stopped."));
    }
    // The fetch can take many seconds, and stopping takes a few more: a
    // session started in the workspace meanwhile was not stopped and, when
    // sessions were named, was not named either.
    let now = sessions_in_workspace(&target)?;
    let ids = |sessions: &[SessionEntry]| sessions.iter().map(|session| session.id.clone()).collect::<std::collections::BTreeSet<_>>();
    if ids(&now) != ids(&affected) {
        let titles: Vec<String> = now.iter().map(|session| format!("• {}", session.title)).collect();
        return Err(format!("{SESSIONS_CHANGED}, while it was being checked. Nothing was removed; the sessions that were in it are stopped. It now holds:\n{}", titles.join("\n")));
    }
    let on_disk = std::fs::symlink_metadata(&target).is_ok();
    let removal = if on_disk {
        let verified_head = if after.safe { after.head.as_deref() } else { None };
        let options = crate::workspaces::DeleteOptions { delete_branch: request.delete_branch, direct: request.direct, verified_head };
        crate::workspaces::delete(&project, &target, options).map_err(err)?
    } else {
        // Not there: only git's record of it is left to clear. Nothing is
        // removed by name, so a directory elsewhere that happens to share
        // the worktree's name is never touched.
        let _ = git::run(&project, &["worktree", "prune"]);
        git::WorktreeRemoval::default()
    };
    let sessions = match request.sessions {
        SessionsFate::Delete => {
            remove_session_entries(&affected)?;
            notify_workspace_deleted(sink, request.project_path, &affected);
            affected
        }
        SessionsFate::Keep => {
            let moved = mark_workspace_sessions_removed(&project, &affected)?;
            notify_workspace_settled(sink, request.project_path, &moved);
            moved
        }
    };
    Ok(WorkspaceRemoved { sessions, removal })
}

/// Record that the workspace these sessions ran in is gone: they keep their
/// conversations and work from the project root from now on.
pub(crate) fn mark_workspace_sessions_removed(project: &Path, affected: &[SessionEntry]) -> Result<Vec<SessionEntry>> {
    let affected_ids: std::collections::HashSet<_> = affected.iter().map(|session| session.id.clone()).collect();
    let branch = git::current_branch(project);
    index::update(|sessions| {
        let mut moved = Vec::new();
        for session in sessions {
            if affected_ids.contains(&session.id) {
                index::mark_workspace_removed(session, branch.clone());
                session.modified = index::now();
                moved.push(session.clone());
            }
        }
        Ok(moved)
    })
    .map_err(err)
}

/// Drop sessions from the index along with their transcript logs,
/// attachments and the agent CLIs' own data for them. Callers stop whatever
/// the tabs were running first.
pub(crate) fn remove_session_entries(doomed: &[SessionEntry]) -> Result<()> {
    if doomed.is_empty() {
        return Ok(());
    }
    let ids: std::collections::HashSet<&str> = doomed.iter().map(|s| s.id.as_str()).collect();
    index::update(|sessions| {
        sessions.retain(|s| !ids.contains(s.id.as_str()));
        Ok(())
    })
    .map_err(err)?;
    let sessions_dir = store::sessions_dir().ok();
    let attachments_dir = store::root().ok().map(|root| root.join("attachments"));
    for session in doomed {
        if let Some(dir) = &sessions_dir {
            let _ = std::fs::remove_dir_all(dir.join(&session.id));
        }
        if let Some(dir) = &attachments_dir {
            let _ = std::fs::remove_dir_all(dir.join(&session.id));
        }
        // A quick chat's scratch directory is found by the session's id, so
        // one that was pointed elsewhere or moved into a project is covered.
        if let Err(error) = store::quick::remove(&session.id) {
            log::warn!("remove the scratch directory of session {}: {error:#}", session.id);
        }
    }
    // What the agent CLIs kept for these sessions goes with them. Without
    // the index there is no telling what another session still uses, so
    // nothing is removed then.
    match index::load() {
        Ok(remaining) => {
            let freed = crate::agent_data::remove_for_deleted_sessions(doomed, &remaining);
            if freed > 0 {
                log::info!("removed {freed} bytes of agent data for {} deleted session(s)", doomed.len());
            }
        }
        Err(error) => log::warn!("agent data kept: the session index could not be read: {error:#}"),
    }
    Ok(())
}

/// Title, pin and archive changes to one session. `None` leaves a field as it is.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
}

impl SessionPatch {
    pub fn is_empty(&self) -> bool {
        self.title.is_none() && self.pinned.is_none() && self.archived.is_none()
    }
}

/// Apply a [`SessionPatch`] and return the updated entry.
pub(crate) fn update_session_meta(session_id: &str, patch: &SessionPatch) -> Result<SessionEntry> {
    index::update_session(session_id, |s| {
        if let Some(title) = &patch.title {
            s.title = title.clone();
        }
        if let Some(pinned) = patch.pinned {
            s.pinned = pinned;
        }
        if let Some(archived) = patch.archived {
            s.archived = archived;
        }
        Ok(s.clone())
    })
    .map_err(err)
}

/// Add an agent tab to a session and make it the active one.
pub(crate) fn add_tab_entry(session_id: &str, tab: &NewTab) -> Result<TabEntry> {
    let t = new_tab_entry(tab);
    let out = t.clone();
    index::update_session(session_id, |s| {
        s.tabs.push(t);
        s.active_tab = Some(out.id.clone());
        Ok(())
    })
    .map_err(err)?;
    Ok(out)
}

/// Delete one session: its index entry, logs, attachments and the agents'
/// own data for it. Nothing else goes: not its workspace, and never another
/// session, whatever they share. A workspace is removed only through
/// [`remove_workspace`]. `stop` ends what the session's tabs are running.
pub(crate) fn delete_session_blocking(sink: &dyn EventSink, session_id: &str, stop: &dyn Fn(&SessionEntry)) -> Result<SessionEntry> {
    let entry = index::get(session_id).map_err(err)?;
    stop(&entry);
    remove_session_entries(std::slice::from_ref(&entry))?;
    notify_sessions_deleted(sink, std::slice::from_ref(&entry));
    Ok(entry)
}

/// The workspace a session would take along if asked to: a worktree (not the
/// project's own checkout) that still exists in the index for this session
/// and that no other session runs in. `None` when there is none, or when
/// other sessions use it.
pub(crate) fn sole_workspace_of(session_id: &str) -> Result<Option<String>> {
    let entry = index::get(session_id).map_err(err)?;
    if entry.worktree_name.is_none() || entry.worktree_removed {
        return Ok(None);
    }
    let same = |a: &str, b: &str| std::fs::canonicalize(a).ok().zip(std::fs::canonicalize(b).ok()).map(|(a, b)| a == b).unwrap_or(a == b);
    if same(&entry.cwd, &entry.project_path) {
        return Ok(None);
    }
    Ok(sessions_sharing_worktree(session_id)?.is_empty().then_some(entry.cwd))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git::run(p, &["init", "-q", "-b", "main"]).unwrap();
        git::run(p, &["config", "user.email", "t@example.com"]).unwrap();
        git::run(p, &["config", "user.name", "T"]).unwrap();
        std::fs::write(p.join("a.txt"), "hello\n").unwrap();
        git::run(p, &["add", "."]).unwrap();
        git::run(p, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    fn worktree_session(project: &Path) -> SessionEntry {
        create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: None,
            use_worktree: true,
            base_ref: None,
            worktree_name: None,
            on_main: false,
            issue: None,
            automation: None,
            cwd: None,
            tab: Some(NewTab { harness: "claude".into(), model: String::new(), effort: None, permission_mode: None }),
        })
        .unwrap()
    }

    #[test]
    fn failed_fetch_warning_survives_session_storage() {
        let _home = crate::store::temp_home();
        let project = repo();
        let missing = project.path().join("missing-remote");
        git::run(project.path(), &["remote", "add", "origin", missing.to_str().unwrap()]).unwrap();
        let session = worktree_session(project.path());
        let stored = index::get(&session.id).unwrap();
        let base = stored.worktree_base.unwrap();
        assert!(!base.fetched);
        assert!(base.warning.unwrap().contains("may be out of date"));
        assert_eq!(Some(base.commit), git::head_commit(Path::new(&session.cwd)));
    }

    fn named_request(project: &Path, title: Option<&str>) -> NewSession {
        serde_json::from_value(serde_json::json!({
            "projectPath": project, "title": title, "useWorktree": true,
            "tab": { "harness": "codex" },
        })).unwrap()
    }

    #[test]
    fn creates_named_sessions_and_derives_unique_title_slugs() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let sink = crate::sink::BroadcastSink::new(16);
        let entry = create_named_session_blocking(&sink, named_request(dir.path(), Some("#203 fix")), Some("fix-203")).unwrap();
        assert_eq!(entry.title, "#203 fix");
        assert_eq!(entry.worktree_name.as_deref(), Some("fix-203"));
        assert_eq!(entry.branch.as_deref(), Some("raccoon/fix-203"));
        assert_eq!(Path::new(&entry.cwd), git::worktree_path(dir.path(), "fix-203").canonicalize().unwrap());
        assert_eq!(index::get(&entry.id).unwrap(), entry);

        for expected in ["203-fix", "203-fix-2"] {
            let entry = create_named_session_blocking(&sink, named_request(dir.path(), Some("#203 fix")), None).unwrap();
            assert_eq!(entry.title, "#203 fix");
            assert_eq!(entry.worktree_name.as_deref(), Some(expected));
        }
        for title in [None, Some("🔥")] {
            let entry = create_session_entry(named_request(dir.path(), title)).unwrap();
            assert_eq!(entry.title, title.unwrap_or("New session"));
            assert!(names::is_worktree_name(entry.worktree_name.as_deref().unwrap()));
        }
        let mut main = named_request(dir.path(), Some("#203 on main"));
        main.use_worktree = false;
        main.on_main = true;
        let entry = create_session_entry(main).unwrap();
        assert_eq!(entry.title, "#203 on main");
        assert!(entry.worktree_name.is_none());
    }

    #[test]
    fn explicit_invalid_or_taken_names_create_nothing() {
        let _home = crate::store::temp_home();
        let dir = repo();
        git::run(dir.path(), &["branch", "raccoon/branch-only"]).unwrap();
        std::fs::create_dir_all(git::worktree_path(dir.path(), "directory-only")).unwrap();
        let existing = create_session_entry_with_name(named_request(dir.path(), None), Some("fix-203")).unwrap();
        // The index reserves a name even if its checkout has disappeared.
        git::run(dir.path(), &["worktree", "remove", &existing.cwd]).unwrap();
        git::run(dir.path(), &["branch", "-D", "raccoon/fix-203"]).unwrap();
        let sessions = index::load().unwrap();
        let trees = git::run(dir.path(), &["worktree", "list", "--porcelain"]).unwrap();
        let refs = git::run(dir.path(), &["show-ref"]).unwrap();
        for name in ["", "   ", "!!!", "🔥", "branch-only", "directory-only", "fix-203", "Fix 203!"] {
            let error = create_session_entry_with_name(named_request(dir.path(), None), Some(name)).unwrap_err();
            assert!(matches!(error, WorkspaceError::InvalidArguments(_)), "{name}: {error}");
            assert_eq!(index::load().unwrap(), sessions);
            assert_eq!(git::run(dir.path(), &["worktree", "list", "--porcelain"]).unwrap(), trees);
            assert_eq!(git::run(dir.path(), &["show-ref"]).unwrap(), refs);
        }
        assert_eq!(std::fs::read_dir(git::worktree_root(dir.path())).unwrap().count(), 1);

        // A different repository can use the same name.
        let other = repo();
        assert!(create_session_entry_with_name(named_request(other.path(), None), Some("fix-203")).is_ok());
    }

    #[test]
    fn explicit_names_require_a_new_git_worktree() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let mut main = named_request(dir.path(), None);
        main.use_worktree = false;
        main.on_main = true;
        assert!(matches!(create_session_entry_with_name(main, Some("fix-203")), Err(WorkspaceError::InvalidArguments(_))));
        let folder = tempfile::tempdir().unwrap();
        assert!(matches!(create_session_entry_with_name(named_request(folder.path(), None), Some("fix-203")), Err(WorkspaceError::InvalidArguments(_))));
        assert!(index::load().unwrap().is_empty());
        assert!(!git::worktree_root(dir.path()).exists());
        assert!(!git::worktree_root(folder.path()).exists());
    }

    #[test]
    fn concurrent_requests_cannot_claim_the_same_explicit_name() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let requests = (0..2).map(|_| {
            let req = named_request(dir.path(), Some("#203 fix"));
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                create_session_entry_with_name(req, Some("fix-203"))
            })
        }).collect::<Vec<_>>();
        let results = requests.into_iter().map(|thread| thread.join().unwrap()).collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| matches!(result, Err(WorkspaceError::InvalidArguments(_)))).count(), 1);
        assert_eq!(index::load().unwrap().len(), 1);
    }

    #[test]
    fn issue_metadata_provides_defaults_and_explicit_choices_win() {
        let _home = crate::store::temp_home();
        let dir = repo();
        for (identifier, expected) in [("#203", "203-false-timeout-warning"), ("ENG-42", "eng-42-false-timeout-warning")] {
            let mut req = named_request(dir.path(), None);
            req.issue = Some(IssueRef {
                provider: "github".into(), id: "203".into(), identifier: identifier.into(),
                title: "False timeout warning".into(), url: "https://example.com/issues/203".into(),
            });
            let entry = create_session_entry(req.clone()).unwrap();
            assert_eq!(entry.title, format!("{identifier} False timeout warning"));
            assert_eq!(entry.worktree_name.as_deref(), Some(expected));
            let second = create_session_entry(req.clone()).unwrap();
            assert_eq!(second.worktree_name.unwrap(), format!("{expected}-2"));
            req.title = Some("Custom title".into());
            req.worktree_name = Some(format!("custom-{identifier}"));
            let custom = create_session_entry(req).unwrap();
            assert_eq!(custom.title, "Custom title");
            assert!(custom.worktree_name.unwrap().starts_with("custom-"));
        }
    }

    #[test]
    fn workspace_rename_rejects_collisions_and_keeps_all_sessions_in_sync() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let first = create_session_entry_with_name(named_request(dir.path(), Some("First")), Some("old")).unwrap();
        let second = create_session_entry(serde_json::from_value(serde_json::json!({
            "projectPath": dir.path(), "cwd": first.cwd, "useWorktree": false, "title": "Second",
        })).unwrap()).unwrap();
        std::fs::write(Path::new(&first.cwd).join("dirty.txt"), "kept").unwrap();
        git::run(dir.path(), &["branch", "raccoon/taken"]).unwrap();
        for name in ["!!!", "", "taken"] {
            assert!(matches!(rename_workspace_entries(&first.project_path, &first.cwd, name), Err(WorkspaceError::InvalidArguments(_))));
            assert_eq!(index::get(&first.id).unwrap(), first);
            assert_eq!(index::get(&second.id).unwrap(), second);
            assert!(Path::new(&first.cwd).exists());
        }
        let renamed = rename_workspace_entries(&first.project_path, &first.cwd, "Better Workspace").unwrap();
        assert_eq!(renamed.name, "better-workspace");
        assert_eq!(renamed.branch, "raccoon/better-workspace");
        assert_eq!(renamed.sessions.len(), 2);
        for session in &renamed.sessions {
            assert_eq!(session.cwd, renamed.path);
            assert_eq!(session.branch.as_deref(), Some(renamed.branch.as_str()));
            assert_eq!(session.worktree_name.as_deref(), Some(renamed.name.as_str()));
            assert_eq!(index::get(&session.id).unwrap(), *session);
        }
        assert_eq!(std::fs::read_to_string(Path::new(&renamed.path).join("dirty.txt")).unwrap(), "kept");
        assert!(!Path::new(&first.cwd).exists());
        assert!(rename_workspace_entries(&first.project_path, &renamed.path, "better-workspace").is_ok());
        let updated = update_session_meta(&first.id, &SessionPatch { title: Some("#203 done".into()), ..Default::default() }).unwrap();
        assert_eq!(updated.title, "#203 done");
        assert_eq!(updated.cwd, renamed.path);
        assert_eq!(index::get(&second.id).unwrap().title, "Second");
    }

    /// Makes a directory read-only for the length of a test, so nothing in it
    /// can be unlinked, and writable again afterwards so the temp dir can go.
    struct ReadOnly(PathBuf);

    impl ReadOnly {
        fn new(dir: &Path) -> Self {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).unwrap();
            Self(dir.to_path_buf())
        }
    }

    impl Drop for ReadOnly {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }

    const CONVERSATION: &str = "11111111-1111-4111-8111-111111111111";

    /// Give the session's first tab a conversation and write its Claude
    /// transcript where the CLI would, under the temporary home.
    fn claude_transcript(session: &SessionEntry, conversation: &str) -> PathBuf {
        index::update_tab(&session.id, &session.tabs[0].id, |tab| {
            tab.provider_session_id = Some(conversation.into());
            Ok(())
        })
        .unwrap();
        let folder = crate::agent_data::claude_projects_root().unwrap().join(crate::harness::claude::transcript::encoded_cwd(&session.cwd));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join(format!("{conversation}.jsonl"));
        std::fs::write(&file, format!("{}\n", serde_json::json!({ "type": "user", "cwd": session.cwd }))).unwrap();
        file
    }

    fn sink() -> crate::sink::BroadcastSink {
        crate::sink::BroadcastSink::new(16)
    }

    /// Another session running in an existing checkout.
    fn session_in(project: &Path, cwd: &str, title: &str) -> SessionEntry {
        create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: Some(title.into()),
            use_worktree: false,
            base_ref: None,
            worktree_name: None,
            on_main: false,
            issue: None,
            automation: None,
            cwd: Some(cwd.into()),
            tab: None,
        })
        .unwrap()
    }

    fn request<'a>(session: &'a SessionEntry, fate: SessionsFate, confirmation: Confirmation, direct: git::DirectDelete) -> WorkspaceRemoval<'a> {
        WorkspaceRemoval {
            project_path: &session.project_path,
            path: &session.cwd,
            sessions: fate,
            delete_branch: true,
            confirmation,
            expected_sessions: None,
            direct,
            fetch: crate::landed::Fetch::Skip,
        }
    }

    /// Remove a session's workspace with a blanket second confirmation.
    /// These repositories have no remote, so nothing in them can be verified
    /// as merged.
    fn remove(session: &SessionEntry, fate: SessionsFate, direct: git::DirectDelete, stop: &dyn Fn(&SessionEntry)) -> Result<WorkspaceRemoved> {
        remove_workspace(&sink(), &request(session, fate, Confirmation::Forced, direct), stop)
    }

    /// A project with a remote, so "merged" can be verified.
    fn repo_with_remote() -> (tempfile::TempDir, tempfile::TempDir) {
        let dir = repo();
        let remote = tempfile::tempdir().unwrap();
        git::run(remote.path(), &["init", "-q", "--bare", "-b", "main"]).unwrap();
        git::run(dir.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]).unwrap();
        git::run(dir.path(), &["push", "-q", "-u", "origin", "main"]).unwrap();
        (dir, remote)
    }

    fn quick_chat(cwd: Option<&Path>) -> SessionEntry {
        create_quick_chat_entry(NewQuickChat {
            title: None,
            cwd: cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
            tab: Some(NewTab { harness: "claude".into(), model: String::new(), effort: None, permission_mode: None }),
        })
        .unwrap()
    }

    fn scratch_root() -> PathBuf {
        store::quick::root().unwrap().canonicalize().unwrap()
    }

    #[test]
    fn a_quick_chat_needs_no_project_and_runs_in_a_scratch_directory_of_its_own() {
        let _home = crate::store::temp_home();
        assert!(projects::list().unwrap().0.is_empty());
        let sink = sink();
        let mut events = sink.subscribe();
        let first = create_quick_chat_blocking(&sink, NewQuickChat { title: Some("What is a monad?".into()), cwd: None, tab: Some(NewTab { harness: "codex".into(), model: String::new(), effort: None, permission_mode: None }) }).unwrap();
        assert_eq!(&*events.try_recv().unwrap().event, "session_created");

        assert_eq!(first.kind, SessionKind::Quick);
        assert_eq!(first.project(), None, "a quick chat has no project");
        assert_eq!(first.title, "What is a monad?");
        // Its directory is its own, under the TerminalX home, and exists.
        assert_eq!(Path::new(&first.cwd), scratch_root().join(&first.id));
        assert_eq!(first.project_path, first.cwd);
        assert!(Path::new(&first.cwd).is_dir());
        // No worktree, no branch, no base.
        assert!(first.worktree_name.is_none() && first.branch.is_none() && first.base_ref.is_none() && first.worktree_base.is_none());
        assert_eq!(first.tabs.len(), 1);
        assert_eq!(first.active_tab.as_deref(), Some(first.tabs[0].id.as_str()));
        assert_eq!(index::get(&first.id).unwrap(), first);
        // Nothing was registered as a project to make it.
        assert!(projects::list().unwrap().0.is_empty());

        // A second one shares nothing with the first; an untitled one is named.
        let second = quick_chat(None);
        assert_ne!(second.cwd, first.cwd);
        assert_eq!(second.title, QUICK_CHAT_TITLE);
        // A terminal-only quick chat has no agent tab.
        let shell_only = create_quick_chat_entry(NewQuickChat::default()).unwrap();
        assert!(shell_only.tabs.is_empty() && shell_only.active_tab.is_none());
        assert_eq!(index::load().unwrap().len(), 3);
    }

    #[test]
    fn a_quick_chat_can_start_in_a_folder_that_does_not_become_a_project() {
        let _home = crate::store::temp_home();
        let folder = tempfile::tempdir().unwrap();
        let chat = quick_chat(Some(folder.path()));
        assert_eq!(Path::new(&chat.cwd), folder.path().canonicalize().unwrap());
        assert!(chat.is_quick() && chat.branch.is_none());
        // It still has a scratch directory to go back to, named for it.
        assert_eq!(Path::new(&chat.project_path), scratch_root().join(&chat.id));
        assert!(projects::list().unwrap().0.is_empty());

        // A repository is used as it is: on its branch, with no worktree cut.
        let repository = repo();
        let in_repo = quick_chat(Some(repository.path()));
        assert_eq!(in_repo.branch.as_deref(), Some("main"));
        assert!(in_repo.worktree_name.is_none());
        assert!(!git::worktree_root(repository.path()).exists());
        assert!(projects::list().unwrap().0.is_empty());
    }

    #[test]
    fn a_quick_chat_that_cannot_be_created_leaves_no_session_and_no_directory() {
        let _home = crate::store::temp_home();
        let missing = tempfile::tempdir().unwrap().path().join("gone");
        let error = create_quick_chat_entry(NewQuickChat { title: None, cwd: Some(missing.to_string_lossy().into_owned()), tab: None }).unwrap_err();
        assert!(error.contains("resolve"), "{error}");
        assert!(index::load().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(store::quick::root().unwrap()).unwrap().count(), 0);
    }

    #[test]
    fn deleting_a_quick_chat_removes_its_scratch_directory_and_what_the_agent_kept_for_it() {
        let _home = crate::store::temp_home();
        let chat = quick_chat(None);
        let bystander = quick_chat(None);
        let transcript = claude_transcript(&chat, CONVERSATION);
        std::fs::write(Path::new(&chat.cwd).join("notes.md"), "kept until deleted").unwrap();
        assert_eq!(quick_chat_scratch(&chat.id).unwrap(), QuickChatScratch { path: store::quick::dir(&chat.id).unwrap().to_string_lossy().into_owned(), files: 1, more: false, in_use: true });

        let stopped = std::cell::RefCell::new(Vec::new());
        delete_session_blocking(&sink(), &chat.id, &|s| stopped.borrow_mut().push(s.id.clone())).unwrap();
        assert_eq!(*stopped.borrow(), vec![chat.id.clone()]);
        assert!(!Path::new(&chat.cwd).exists(), "the scratch directory goes with its chat");
        assert!(!transcript.exists());
        assert!(!transcript.parent().unwrap().exists(), "the agent's folder for a directory that is gone goes too");
        assert!(index::get(&chat.id).is_err());
        // Another quick chat's directory is not touched.
        assert!(Path::new(&bystander.cwd).is_dir());
        assert_eq!(index::load().unwrap().len(), 1);
    }

    #[test]
    fn a_quick_chat_can_be_pointed_at_a_folder_and_back_and_its_conversation_follows() {
        let _home = crate::store::temp_home();
        let chat = quick_chat(None);
        let began = claude_transcript(&chat, CONVERSATION);
        let folder = tempfile::tempdir().unwrap();
        let target = folder.path().canonicalize().unwrap();
        let stopped = std::cell::Cell::new(0);
        let stop = |_: &SessionEntry| stopped.set(stopped.get() + 1);
        let sink = sink();
        let mut events = sink.subscribe();

        let moved = set_quick_chat_cwd(&sink, &chat.id, Some(folder.path().to_str().unwrap()), &stop).unwrap();
        assert_eq!(stopped.get(), 1, "its agents are stopped before they are started elsewhere");
        assert_eq!(Path::new(&moved.cwd), target);
        assert!(moved.is_quick(), "pointing it at a folder does not give it a project");
        assert_eq!(moved.project_path, chat.project_path);
        assert_eq!(&*events.try_recv().unwrap().event, "session_updated");
        assert!(projects::list().unwrap().0.is_empty(), "the folder is not registered as a project");
        // The conversation is where the CLI will look when it resumes in the folder.
        let projects_root = crate::agent_data::claude_projects_root().unwrap();
        let carried = crate::harness::claude::transcript::transcript_in(&projects_root, &moved.cwd, CONVERSATION);
        assert!(carried.exists() && !began.exists());
        assert_eq!(moved.tabs[0].provider_session_id.as_deref(), Some(CONVERSATION));
        assert!(!quick_chat_scratch(&chat.id).unwrap().in_use);

        // The same folder again changes nothing, and stops nothing.
        set_quick_chat_cwd(&sink, &chat.id, Some(folder.path().to_str().unwrap()), &stop).unwrap();
        assert_eq!(stopped.get(), 1);

        // Back to the scratch directory, made again if it was removed by hand.
        std::fs::remove_dir_all(&chat.cwd).unwrap();
        let back = set_quick_chat_cwd(&sink, &chat.id, None, &stop).unwrap();
        assert_eq!(back.cwd, chat.cwd);
        assert!(Path::new(&back.cwd).is_dir() && back.branch.is_none());
        assert!(began.exists(), "and the conversation came back with it");

        // A folder that is not there is refused, and nothing changes.
        assert!(set_quick_chat_cwd(&sink, &chat.id, Some("/no/such/folder"), &stop).is_err());
        assert_eq!(index::get(&chat.id).unwrap().cwd, chat.cwd);
        assert_eq!(stopped.get(), 2);
    }

    #[test]
    fn only_a_quick_chat_can_be_pointed_elsewhere_or_moved() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = session_in(dir.path(), &dir.path().to_string_lossy(), "Project session");
        let elsewhere = tempfile::tempdir().unwrap();
        for error in [
            set_quick_chat_cwd(&sink(), &session.id, Some(elsewhere.path().to_str().unwrap()), &|_| panic!("nothing is stopped")).unwrap_err(),
            move_quick_chat_to_project(&sink(), &session.id, elsewhere.path().to_str().unwrap(), &|_| panic!("nothing is stopped")).unwrap_err(),
        ] {
            assert!(error.contains("belongs to a project"), "{error}");
        }
        assert_eq!(index::get(&session.id).unwrap(), session);
    }

    #[test]
    fn moving_a_quick_chat_into_a_project_keeps_its_tabs_and_history() {
        let _home = crate::store::temp_home();
        let chat = quick_chat(None);
        let began = claude_transcript(&chat, CONVERSATION);
        let log = store::log_path(&chat.id, &chat.tabs[0].id).unwrap();
        std::fs::write(&log, "{\"transcript\":true}\n").unwrap();
        let project = repo();
        let sink = sink();
        let mut events = sink.subscribe();
        let stopped = std::cell::Cell::new(0);

        let moved = move_quick_chat_to_project(&sink, &chat.id, project.path().to_str().unwrap(), &|_| stopped.set(stopped.get() + 1)).unwrap();
        let project_path = project.path().canonicalize().unwrap();
        assert_eq!(stopped.get(), 1);
        assert_eq!(moved.kind, SessionKind::Project);
        assert_eq!(moved.project(), Some(project_path.to_str().unwrap()));
        assert_eq!(Path::new(&moved.cwd), project_path);
        assert_eq!(moved.branch.as_deref(), Some("main"));
        assert!(moved.worktree_name.is_none());
        // The same session, the same tabs, the same conversation and the same saved transcript.
        assert_eq!(moved.id, chat.id);
        assert_eq!(moved.title, chat.title);
        assert_eq!(moved.tabs.iter().map(|tab| &tab.id).collect::<Vec<_>>(), chat.tabs.iter().map(|tab| &tab.id).collect::<Vec<_>>());
        assert_eq!(moved.tabs[0].provider_session_id.as_deref(), Some(CONVERSATION));
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "{\"transcript\":true}\n");
        let projects_root = crate::agent_data::claude_projects_root().unwrap();
        assert!(crate::harness::claude::transcript::transcript_in(&projects_root, &moved.cwd, CONVERSATION).exists() && !began.exists());
        assert_eq!(index::get(&chat.id).unwrap(), moved);
        // The project was added for it, and listeners heard about both.
        assert_eq!(projects::list().unwrap().0.iter().map(|p| p.path.clone()).collect::<Vec<_>>(), vec![moved.project_path.clone()]);
        assert_eq!(&*events.try_recv().unwrap().event, "session_updated");
        assert_eq!(&*events.try_recv().unwrap().event, WORKSPACES_CHANGED_EVENT);
        // An empty scratch directory is not left behind.
        assert!(!Path::new(&chat.cwd).exists());
        // It is an ordinary session of the project from here on.
        assert_eq!(taken_worktree_names(&project_path).unwrap(), Vec::<String>::new());
        assert!(move_quick_chat_to_project(&sink, &chat.id, project.path().to_str().unwrap(), &|_| {}).is_err());
    }

    #[test]
    fn a_moved_quick_chat_keeps_the_files_it_made_until_it_is_deleted() {
        let _home = crate::store::temp_home();
        let chat = quick_chat(None);
        let made = Path::new(&chat.cwd).join("draft.md");
        std::fs::write(&made, "the agent wrote this").unwrap();
        let project = tempfile::tempdir().unwrap();
        let moved = move_quick_chat_to_project(&sink(), &chat.id, project.path().to_str().unwrap(), &|_| {}).unwrap();
        assert!(made.exists(), "the conversation may refer to it");
        assert_eq!(quick_chat_scratch(&moved.id).unwrap().files, 1);
        assert!(!quick_chat_scratch(&moved.id).unwrap().in_use);
        delete_session_blocking(&sink(), &moved.id, &|_| {}).unwrap();
        assert!(!made.exists() && !Path::new(&chat.cwd).exists());
        assert!(project.path().exists(), "the project is the reader's, not the session's");
    }

    const PARENT: &str = "22222222-2222-4222-8222-222222222222";

    /// A forked quick chat before its first send: its tab names the parent
    /// conversation, and a copy of the parent's transcript sits in the fork's
    /// own Claude folder for the CLI to reopen.
    fn unstarted_fork() -> (SessionEntry, PathBuf) {
        let chat = quick_chat(None);
        index::update_tab(&chat.id, &chat.tabs[0].id, |tab| {
            tab.fork_from = Some(PARENT.into());
            Ok(())
        })
        .unwrap();
        let folder = crate::agent_data::claude_projects_root().unwrap().join(crate::harness::claude::transcript::encoded_cwd(&chat.cwd));
        std::fs::create_dir_all(&folder).unwrap();
        let copy = folder.join(format!("{PARENT}.jsonl"));
        std::fs::write(&copy, "{\"type\":\"user\"}\n").unwrap();
        (index::get(&chat.id).unwrap(), copy)
    }

    #[test]
    fn a_fork_that_has_not_started_takes_its_parents_conversation_along_when_it_moves() {
        let _home = crate::store::temp_home();
        let (fork, copy) = unstarted_fork();
        let folder = tempfile::tempdir().unwrap();
        let moved = set_quick_chat_cwd(&sink(), &fork.id, Some(folder.path().to_str().unwrap()), &|_| {}).unwrap();
        let projects_root = crate::agent_data::claude_projects_root().unwrap();
        // Where the CLI will look when it reopens the parent from the new directory...
        assert!(crate::harness::claude::transcript::transcript_in(&projects_root, &moved.cwd, PARENT).exists());
        // ...and still where it was: a fork never takes its parent's away.
        assert!(copy.exists());
    }

    #[test]
    fn deleting_a_forked_quick_chat_removes_the_copy_of_its_parents_transcript() {
        let _home = crate::store::temp_home();
        let (fork, copy) = unstarted_fork();
        delete_session_blocking(&sink(), &fork.id, &|_| {}).unwrap();
        assert!(!copy.exists(), "the copy made for the fork outlived it");
        assert!(!copy.parent().unwrap().exists(), "and so did its folder");
    }

    fn aged(session: &SessionEntry, days: i64) {
        let then = (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        index::update(|sessions| {
            sessions.iter_mut().find(|s| s.id == session.id).unwrap().modified = then.clone();
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn idle_quick_chats_are_removed_after_the_retention_and_nothing_else_is() {
        let _home = crate::store::temp_home();
        let project = tempfile::tempdir().unwrap();
        let old = quick_chat(None);
        let recent = quick_chat(None);
        let pinned = quick_chat(None);
        let working = quick_chat(None);
        let in_use = quick_chat(None);
        let ordinary = session_in(project.path(), &project.path().to_string_lossy(), "Old project session");
        for session in [&old, &pinned, &working, &in_use, &ordinary] {
            aged(session, 45);
        }
        aged(&recent, 3);
        index::update(|sessions| {
            sessions.iter_mut().find(|s| s.id == pinned.id).unwrap().pinned = true;
            sessions.iter_mut().find(|s| s.id == working.id).unwrap().tabs[0].status = TabStatus::Waiting;
            Ok(())
        })
        .unwrap();
        let busy = |session: &SessionEntry| session.id == in_use.id;
        let stopped = std::cell::RefCell::new(Vec::new());
        let stop = |session: &SessionEntry| stopped.borrow_mut().push(session.id.clone());
        let sink = sink();
        let mut events = sink.subscribe();

        // Kept for ever: nothing goes, however old.
        assert!(sweep_idle_quick_chats(&sink, 0, &busy, &stop).unwrap().is_empty());
        assert_eq!(index::load().unwrap().len(), 6);

        let removed = sweep_idle_quick_chats(&sink, 30, &busy, &stop).unwrap();
        assert_eq!(removed.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec![old.id.as_str()]);
        assert_eq!(*stopped.borrow(), vec![old.id.clone()]);
        assert!(!Path::new(&old.cwd).exists());
        assert_eq!(&*events.try_recv().unwrap().event, SESSION_DELETED_EVENT);
        let mut kept: Vec<String> = index::load().unwrap().into_iter().map(|s| s.id).collect();
        kept.sort();
        let mut expected = vec![recent.id.clone(), pinned.id.clone(), working.id.clone(), in_use.id.clone(), ordinary.id.clone()];
        expected.sort();
        assert_eq!(kept, expected);
        for session in [&recent, &pinned, &working, &in_use] {
            assert!(Path::new(&session.cwd).is_dir());
        }
    }

    #[test]
    fn scratch_directories_no_session_uses_are_removed_once_they_are_old() {
        let _home = crate::store::temp_home();
        let chat = quick_chat(None);
        let lost = store::quick::create("left-by-a-crash").unwrap();
        // With no session at all there is no telling a lost index from an empty one.
        index::save(&[]).unwrap();
        assert_eq!(remove_orphan_scratch(std::time::Duration::ZERO), 0);
        index::save(std::slice::from_ref(&chat)).unwrap();
        // Just made: it may be a session whose index entry is a moment away.
        assert_eq!(remove_orphan_scratch(std::time::Duration::from_secs(3600)), 0);
        assert!(Path::new(&lost).is_dir());
        assert_eq!(remove_orphan_scratch(std::time::Duration::ZERO), 1);
        assert!(!Path::new(&lost).exists());
        assert!(Path::new(&chat.cwd).is_dir(), "a directory a session uses is never an orphan");
    }

    #[test]
    fn deleting_a_session_never_deletes_another_session_or_its_workspace() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let companion = session_in(dir.path(), &session.cwd, "Companion");
        let stopped = std::cell::RefCell::new(Vec::new());

        let deleted = delete_session_blocking(&sink(), &session.id, &|s| stopped.borrow_mut().push(s.id.clone())).unwrap();
        assert_eq!(deleted.id, session.id);
        assert_eq!(*stopped.borrow(), vec![session.id.clone()], "only the deleted session is stopped");
        assert!(index::get(&session.id).is_err());
        assert!(index::get(&companion.id).is_ok(), "the session sharing its workspace is untouched");
        assert!(Path::new(&session.cwd).join("a.txt").exists(), "the workspace stays");

        // The last one out leaves the workspace too: it becomes an empty workspace.
        delete_session_blocking(&sink(), &companion.id, &|_| {}).unwrap();
        assert!(Path::new(&session.cwd).join("a.txt").exists());
        assert!(index::load().unwrap().is_empty());
    }

    #[test]
    fn a_session_takes_its_workspace_along_only_when_it_is_the_only_one_there() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        assert_eq!(sole_workspace_of(&session.id).unwrap().as_deref(), Some(session.cwd.as_str()));

        // Recorded through a path that is not the canonical one: still the same workspace.
        let companion = session_in(dir.path(), &format!("{}/.", session.cwd), "Companion");
        assert_eq!(sole_workspace_of(&session.id).unwrap(), None);
        assert_eq!(sessions_sharing_worktree(&session.id).unwrap().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec![companion.id.as_str()]);

        // A session at the project root has no workspace of its own to take.
        let at_root = session_in(dir.path(), &dir.path().to_string_lossy(), "Root");
        assert_eq!(sole_workspace_of(&at_root.id).unwrap(), None);
    }

    #[test]
    fn deleting_a_workspace_deletes_every_session_in_it() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let companion = session_in(dir.path(), &session.cwd, "Companion");
        let bystander = session_in(dir.path(), &dir.path().to_string_lossy(), "Root");
        let stopped = std::cell::Cell::new(0);

        let removed = remove(&session, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| stopped.set(stopped.get() + 1)).unwrap();
        assert_eq!(stopped.get(), 2);
        let mut ids: Vec<&str> = removed.sessions.iter().map(|s| s.id.as_str()).collect();
        ids.sort();
        let mut expected = vec![session.id.as_str(), companion.id.as_str()];
        expected.sort();
        assert_eq!(ids, expected);
        assert!(!Path::new(&session.cwd).exists());
        assert_eq!(index::load().unwrap().iter().map(|s| s.id.clone()).collect::<Vec<_>>(), vec![bystander.id]);
    }

    #[test]
    fn settling_removes_the_workspace_and_keeps_its_sessions() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let transcript = claude_transcript(&session, CONVERSATION);

        let removed = remove(&session, SessionsFate::Keep, git::DirectDelete::Allowed, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists());
        assert_eq!(removed.sessions.len(), 1);
        let kept = index::get(&session.id).unwrap();
        assert!(kept.worktree_removed && kept.worktree_name.is_none());
        assert_eq!(kept.cwd, kept.project_path);
        assert_eq!(kept.removed_workspace.as_ref().map(|w| w.path.as_str()), Some(session.cwd.as_str()));
        assert!(transcript.exists(), "resume still reads the conversation");

        // Deleting the kept session later removes what the agent kept for it.
        delete_session_blocking(&sink(), &session.id, &|_| {}).unwrap();
        assert!(!transcript.exists());
    }

    #[test]
    fn an_unsafe_workspace_is_left_alone_without_the_second_confirmation() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        std::fs::write(Path::new(&session.cwd).join("unsaved.txt"), "x").unwrap();
        let stopped = std::cell::Cell::new(0);

        let error = remove_workspace(&sink(), &request(&session, SessionsFate::Delete, Confirmation::Single, git::DirectDelete::Never), &|_| stopped.set(stopped.get() + 1)).unwrap_err();
        assert!(error.starts_with(NEEDS_CONFIRMATION), "{error}");
        assert!(error.contains("1 uncommitted file"), "{error}");
        assert_eq!(stopped.get(), 0, "nothing is stopped for a removal that does not happen");
        assert!(Path::new(&session.cwd).join("unsaved.txt").exists());
        assert!(index::get(&session.id).is_ok());

        remove(&session, SessionsFate::Delete, git::DirectDelete::Never, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists());
        assert!(index::get(&session.id).is_err());
    }

    #[test]
    fn a_second_confirmation_counts_only_for_what_was_shown() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let cwd = Path::new(&session.cwd);
        std::fs::write(cwd.join("unsaved.txt"), "x").unwrap();
        // What the dialog showed, and the person confirmed.
        let shown = crate::landed::check(dir.path(), cwd, crate::landed::Fetch::Skip).digest;

        // More appears before the removal: the confirmation no longer covers it.
        std::fs::write(cwd.join("more.txt"), "y").unwrap();
        let error = remove_workspace(&sink(), &request(&session, SessionsFate::Delete, Confirmation::Shown(shown.clone()), git::DirectDelete::Allowed), &|_| {}).unwrap_err();
        assert!(error.starts_with(NEEDS_CONFIRMATION) && error.contains("not what was confirmed"), "{error}");
        assert!(error.contains("2 uncommitted files"), "the new state is what is shown: {error}");
        assert!(cwd.join("more.txt").exists());
        assert!(index::get(&session.id).is_ok());

        // Confirmed again for the state as it is now, it goes.
        let now = crate::landed::check(dir.path(), cwd, crate::landed::Fetch::Skip).digest;
        remove_workspace(&sink(), &request(&session, SessionsFate::Delete, Confirmation::Shown(now), git::DirectDelete::Allowed), &|_| {}).unwrap();
        assert!(!cwd.exists());
    }

    #[test]
    fn work_written_while_the_sessions_are_being_stopped_is_not_deleted() {
        let _home = crate::store::temp_home();
        let (dir, _remote) = repo_with_remote();
        let session = worktree_session(dir.path());
        let cwd = PathBuf::from(&session.cwd);
        let mut request = request(&session, SessionsFate::Delete, Confirmation::Single, git::DirectDelete::Never);
        request.fetch = crate::landed::Fetch::Fresh;

        // The check finds it clean and merged; then, before it has stopped,
        // the agent writes a file.
        let late = cwd.join("written-while-stopping.txt");
        let error = remove_workspace(&sink(), &request, &|_| std::fs::write(&late, "the agent's last output").unwrap()).unwrap_err();
        assert!(error.starts_with(NEEDS_CONFIRMATION), "{error}");
        assert!(error.contains("changed while its sessions were being stopped"), "{error}");
        assert!(late.exists());
        assert!(index::get(&session.id).is_ok());
    }

    #[test]
    fn a_session_added_since_the_dialog_opened_is_not_deleted_unnamed() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        // The dialog named one session.
        let shown = vec![session.id.clone()];
        // Another is started in the workspace from a second window.
        let newcomer = session_in(dir.path(), &session.cwd, "Started meanwhile");
        let stopped = std::cell::Cell::new(0);
        let mut removal = request(&session, SessionsFate::Delete, Confirmation::Forced, git::DirectDelete::Allowed);
        removal.expected_sessions = Some(&shown);

        let error = remove_workspace(&sink(), &removal, &|_| stopped.set(stopped.get() + 1)).unwrap_err();
        assert!(error.starts_with(SESSIONS_CHANGED), "{error}");
        assert!(error.contains("Started meanwhile"), "the error names what is there now: {error}");
        assert_eq!(stopped.get(), 0);
        assert!(Path::new(&session.cwd).join("a.txt").exists());
        assert!(index::get(&session.id).is_ok() && index::get(&newcomer.id).is_ok());

        // One that left is a change too.
        delete_session_blocking(&sink(), &newcomer.id, &|_| {}).unwrap();
        delete_session_blocking(&sink(), &session.id, &|_| {}).unwrap();
        assert!(remove_workspace(&sink(), &removal, &|_| {}).unwrap_err().starts_with(SESSIONS_CHANGED));

        // Named as it is now (no sessions), it goes.
        let none: Vec<String> = Vec::new();
        removal.expected_sessions = Some(&none);
        remove_workspace(&sink(), &removal, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists());
    }

    #[test]
    fn a_session_started_while_the_workspace_was_being_checked_stops_the_removal() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let project = dir.path().to_path_buf();
        let cwd = session.cwd.clone();
        // It arrives after the first look at the sessions: here, while the
        // one that was there is being stopped.
        let started = std::cell::Cell::new(false);
        let stop = |_: &SessionEntry| {
            if !started.replace(true) {
                session_in(&project, &cwd, "Started during the check");
            }
        };
        let error = remove(&session, SessionsFate::Delete, git::DirectDelete::Allowed, &stop).unwrap_err();
        assert!(error.starts_with(SESSIONS_CHANGED) && error.contains("Started during the check"), "{error}");
        assert!(Path::new(&session.cwd).join("a.txt").exists());
        assert_eq!(index::load().unwrap().len(), 2, "neither session is deleted");
    }

    #[test]
    fn a_session_running_in_a_subdirectory_belongs_to_the_workspace() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let sub = Path::new(&session.cwd).join("docs");
        std::fs::create_dir_all(&sub).unwrap();
        let nested = session_in(dir.path(), &sub.to_string_lossy(), "In a subdirectory");
        let at_root = session_in(dir.path(), &dir.path().to_string_lossy(), "Root");

        let ids = |path: &Path| -> Vec<String> {
            let mut ids: Vec<String> = sessions_in_workspace(path).unwrap().into_iter().map(|s| s.id).collect();
            ids.sort();
            ids
        };
        let mut expected = vec![session.id.clone(), nested.id.clone()];
        expected.sort();
        assert_eq!(ids(Path::new(&session.cwd)), expected);
        // The project's own checkout contains the worktree folder, and does
        // not thereby own the sessions of the worktrees in it.
        assert_eq!(ids(dir.path()), vec![at_root.id.clone()]);

        let removed = remove(&session, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| {}).unwrap();
        assert_eq!(removed.sessions.len(), 2, "it is named, stopped and deleted with the workspace");
        assert!(index::get(&nested.id).is_err());
        assert!(index::get(&at_root.id).is_ok());
    }

    #[test]
    fn a_clean_merged_workspace_needs_no_second_confirmation_and_its_branch_goes() {
        let _home = crate::store::temp_home();
        let (dir, _remote) = repo_with_remote();
        let session = worktree_session(dir.path());
        let name = session.worktree_name.clone().unwrap();
        let mut request = request(&session, SessionsFate::Delete, Confirmation::Single, git::DirectDelete::Never);
        request.fetch = crate::landed::Fetch::Fresh;
        let removed = remove_workspace(&sink(), &request, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists());
        assert_eq!(removed.removal.kept_branch, None);
        assert!(!git::worktree_branch_names(dir.path()).contains(&name));
    }

    #[test]
    fn an_unmerged_branch_is_kept_even_after_the_second_confirmation() {
        let _home = crate::store::temp_home();
        let (dir, _remote) = repo_with_remote();
        let session = worktree_session(dir.path());
        let cwd = Path::new(&session.cwd);
        std::fs::write(cwd.join("work.txt"), "unpushed, unmerged").unwrap();
        git::run(cwd, &["add", "."]).unwrap();
        git::run(cwd, &["commit", "-q", "-m", "only here"]).unwrap();
        let commit = git::run(cwd, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let branch = session.branch.clone().unwrap();
        let shown = crate::landed::check(dir.path(), cwd, crate::landed::Fetch::Fresh).digest;

        let mut request = request(&session, SessionsFate::Delete, Confirmation::Shown(shown), git::DirectDelete::Allowed);
        request.fetch = crate::landed::Fetch::Fresh;
        // "Also delete the branch" is on, as it would be if the person turned it on.
        request.delete_branch = true;
        let removed = remove_workspace(&sink(), &request, &|_| {}).unwrap();
        assert!(!cwd.exists());
        assert_eq!(removed.removal.kept_branch.as_deref(), Some(branch.as_str()), "what the confirmation promised");
        assert_eq!(git::run(dir.path(), &["rev-parse", &branch]).unwrap().trim(), commit);
    }

    #[test]
    fn a_workspace_with_an_initialised_submodule_can_be_removed_after_the_second_confirmation() {
        let _home = crate::store::temp_home();
        let (dir, _remote) = repo_with_remote();
        let lib = tempfile::tempdir().unwrap();
        git::run(lib.path(), &["init", "-q", "-b", "main"]).unwrap();
        git::run(lib.path(), &["-c", "user.name=L", "-c", "user.email=l@example.com", "commit", "-q", "--allow-empty", "-m", "lib"]).unwrap();
        git::run(dir.path(), &["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.path().to_str().unwrap(), "lib"]).unwrap();
        git::run(dir.path(), &["commit", "-q", "-m", "add lib"]).unwrap();
        git::run(dir.path(), &["push", "-q", "origin", "main"]).unwrap();
        let session = worktree_session(dir.path());
        let cwd = Path::new(&session.cwd);
        git::run(cwd, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]).unwrap();
        assert!(cwd.join("lib/.git").exists());

        // Clean and merged, but what is inside a submodule cannot be checked:
        // one confirmation is not enough, and the reason is said.
        let mut single = request(&session, SessionsFate::Delete, Confirmation::Single, git::DirectDelete::Never);
        single.fetch = crate::landed::Fetch::Fresh;
        let error = remove_workspace(&sink(), &single, &|_| {}).unwrap_err();
        assert!(error.starts_with(NEEDS_CONFIRMATION) && error.contains("submodule"), "{error}");
        assert!(cwd.exists());

        // Confirmed for what was shown, it goes. (Git itself refuses to
        // remove a worktree with a submodule unless forced, which is what the
        // confirmed path does.)
        let shown = crate::landed::check(dir.path(), cwd, crate::landed::Fetch::Fresh).digest;
        let mut confirmed = request(&session, SessionsFate::Delete, Confirmation::Shown(shown), git::DirectDelete::Never);
        confirmed.fetch = crate::landed::Fetch::Fresh;
        remove_workspace(&sink(), &confirmed, &|_| {}).unwrap();
        assert!(!cwd.exists());
        assert!(index::get(&session.id).is_err());
    }

    #[test]
    fn a_folder_that_is_not_on_disk_cannot_be_checked_and_needs_the_second_confirmation() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        // Gone from disk: removed by hand, or its volume is not mounted.
        std::fs::remove_dir_all(&session.cwd).unwrap();

        let error = remove_workspace(&sink(), &request(&session, SessionsFate::Delete, Confirmation::Single, git::DirectDelete::Never), &|_| {}).unwrap_err();
        assert!(error.starts_with(NEEDS_CONFIRMATION) && error.contains("not on disk"), "{error}");
        assert!(index::get(&session.id).is_ok(), "its session is not deleted on one confirmation");

        remove(&session, SessionsFate::Delete, git::DirectDelete::Never, &|_| {}).unwrap();
        assert!(index::get(&session.id).is_err());
    }

    #[test]
    fn the_projects_own_checkout_is_never_removed() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let at_root = session_in(dir.path(), &dir.path().to_string_lossy(), "Root");
        assert!(remove(&at_root, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| {}).is_err());
        assert!(dir.path().join("a.txt").exists());
        assert!(index::get(&at_root.id).is_ok());
    }

    #[test]
    fn deleting_a_workspace_removes_its_sessions_agent_data_and_settling_does_not() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let doomed = worktree_session(dir.path());
        let transcript = claude_transcript(&doomed, CONVERSATION);
        remove(&doomed, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| {}).unwrap();
        assert!(!Path::new(&doomed.cwd).exists());
        assert!(!transcript.parent().unwrap().exists());
    }

    #[test]
    fn a_failed_removal_leaves_the_sessions_and_their_agent_data_alone() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let companion = session_in(dir.path(), &session.cwd, "Companion");
        let transcript = claude_transcript(&session, CONVERSATION);
        let stopped = std::cell::Cell::new(0);

        let locked = ReadOnly::new(Path::new(&session.cwd));
        let error = remove(&session, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| stopped.set(stopped.get() + 1)).unwrap_err();
        assert!(error.contains(&session.cwd), "the message names the directory: {error}");
        assert_eq!(stopped.get(), 2, "every session in the workspace is stopped before the removal is tried");
        assert!(Path::new(&session.cwd).join("a.txt").exists());
        assert!(index::get(&session.id).is_ok() && index::get(&companion.id).is_ok(), "the sessions still point at the leftover workspace");
        assert!(transcript.exists());

        // Once whatever held the directory lets go, the same removal works.
        drop(locked);
        let removed = remove(&session, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| {}).unwrap();
        assert_eq!(removed.sessions.len(), 2);
        assert!(!Path::new(&session.cwd).exists());
        assert!(index::load().unwrap().is_empty());
    }

    #[test]
    fn a_workspace_made_under_an_older_worktree_folder_is_removed_by_its_own_path() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        // The worktree folder setting changes after the session was made.
        let settings = crate::store::settings::Settings { worktree_dir: ".elsewhere".into(), ..Default::default() };
        crate::store::settings::save(&settings).unwrap();
        // A directory of the same name under the new folder is not the session's.
        let look_alike = git::worktree_path(dir.path(), session.worktree_name.as_deref().unwrap());
        std::fs::create_dir_all(&look_alike).unwrap();
        std::fs::write(look_alike.join("not-the-sessions.txt"), "keep").unwrap();

        remove(&session, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists(), "the session's real checkout is what goes");
        assert!(look_alike.join("not-the-sessions.txt").exists());
    }

    #[test]
    fn a_workspace_already_gone_takes_nothing_else_by_name() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let name = session.worktree_name.clone().unwrap();
        git::run(dir.path(), &["worktree", "remove", "--force", &session.cwd]).unwrap();
        let settings = crate::store::settings::Settings { worktree_dir: ".elsewhere".into(), ..Default::default() };
        crate::store::settings::save(&settings).unwrap();
        let look_alike = git::worktree_path(dir.path(), &name);
        std::fs::create_dir_all(&look_alike).unwrap();
        std::fs::write(look_alike.join("not-the-sessions.txt"), "keep").unwrap();

        let removed = remove(&session, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| {}).unwrap();
        assert_eq!(removed.sessions.len(), 1);
        assert!(index::get(&session.id).is_err());
        assert!(look_alike.join("not-the-sessions.txt").exists(), "the same-named directory is not the session's");
        assert!(git::worktree_branch_names(dir.path()).contains(&name), "nor is a branch removed by name");
    }

    #[test]
    fn a_caller_that_showed_nothing_never_deletes_a_broken_worktree_directly() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        std::fs::write(Path::new(&session.cwd).join("unsaved.txt"), "x").unwrap();
        std::fs::remove_file(Path::new(&session.cwd).join(".git")).unwrap();

        assert!(remove(&session, SessionsFate::Delete, git::DirectDelete::Never, &|_| {}).is_err());
        assert!(Path::new(&session.cwd).join("unsaved.txt").exists());
        assert!(index::get(&session.id).is_ok());

        // The desktop, after its confirmation, may.
        remove(&session, SessionsFate::Delete, git::DirectDelete::Allowed, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists());
    }
}
