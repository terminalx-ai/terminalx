//! Session index operations shared by the Tauri commands, the control socket
//! and the headless runtime: creating a session (and its worktree) and telling
//! listeners when sessions or workspaces go away.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::sink::EventSink;
use crate::store::index::{self, AutomationRef, IssueRef, SessionEntry, TabEntry, TabStatus};
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
        project_path: project.clone(),
        cwd: project.clone(),
        worktree_name: None,
        branch: git::current_branch(project_path),
        base_ref: None,
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
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    index::load()
        .map(|sessions| {
            sessions
                .into_iter()
                .filter(|session| {
                    std::fs::canonicalize(&session.cwd)
                        .map(|cwd| cwd == target)
                        .unwrap_or_else(|_| Path::new(&session.cwd) == target)
                })
                .collect()
        })
        .map_err(err)
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

/// Delete a workspace together with every session that ran in it: index
/// entries, transcript logs and attachments. Returns the removed sessions so
/// callers can announce them. Tabs must already be stopped.
pub(crate) fn delete_workspace_entries(project_path: &str, path: &str, delete_branch: bool, direct: git::DirectDelete) -> Result<(Vec<SessionEntry>, git::WorktreeRemoval)> {
    let project = std::fs::canonicalize(project_path).unwrap_or_else(|_| PathBuf::from(project_path));
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let affected = sessions_in_workspace(&target)?;
    let removal = crate::workspaces::delete(&project, &target, delete_branch, direct).map_err(err)?;
    remove_session_entries(&affected)?;
    Ok((affected, removal))
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

/// What a session delete removed.
#[derive(Debug, Clone, Default)]
pub(crate) struct Deleted {
    pub sessions: Vec<SessionEntry>,
    /// What became of the worktree's branch and HEAD (see
    /// [`git::remove_worktree`]).
    pub removal: git::WorktreeRemoval,
}

/// Where a session's worktree is, against where removing it by name would
/// look. A worktree is removed by name under the project's worktree folder
/// as it is set now; when the session's checkout is somewhere else (the
/// setting changed since it was made), the name could match a different
/// directory, so it is never removed by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WorktreeTarget {
    /// The session's checkout is the managed path for this name.
    Managed(String),
    /// The checkout is elsewhere and still on disk.
    ElsewhereOnDisk,
    /// The checkout is elsewhere and already gone: nothing to remove.
    ElsewhereGone,
}

pub(crate) fn worktree_target(entry: &SessionEntry, name: &str) -> Result<WorktreeTarget> {
    let managed = git::managed_worktree_path(Path::new(&entry.project_path), name).map_err(err)?;
    let cwd = Path::new(&entry.cwd);
    let same = match (std::fs::canonicalize(cwd), std::fs::canonicalize(&managed)) {
        (Ok(a), Ok(b)) => a == b,
        // Gone, or not resolvable: fall back to the paths as recorded.
        _ => cwd == managed,
    };
    Ok(if same {
        WorktreeTarget::Managed(name.to_string())
    } else if std::fs::symlink_metadata(cwd).is_ok() {
        WorktreeTarget::ElsewhereOnDisk
    } else {
        WorktreeTarget::ElsewhereGone
    })
}

/// The error for a worktree that is not where removing by name would look.
pub(crate) fn elsewhere_error(entry: &SessionEntry) -> String {
    format!(
        "The worktree at {} is not in this project's worktree folder ({}), so it was not removed and the session was kept. Delete the workspace from the sidebar instead.",
        entry.cwd,
        git::worktree_root(Path::new(&entry.project_path)).display()
    )
}

/// Delete a session, its logs, attachments and, when asked, its worktree.
/// Removing the worktree takes every session that ran in it along, since a
/// checkout that no longer exists has nothing left for them to run in.
/// `stop` ends whatever each doomed session's tabs are running, and waits for
/// it, before anything is removed.
///
/// A worktree that cannot be removed fails the whole delete: the error names
/// the directory, the reason and the state it was left in, and every session
/// stays in the index, so the directory is never left on disk with nothing
/// pointing at it and the delete can be tried again.
///
/// `direct` says whether the caller showed the person what would be lost;
/// see [`git::DirectDelete`].
pub(crate) fn delete_session_blocking(
    sink: &dyn EventSink,
    session_id: &str,
    remove_worktree: bool,
    direct: git::DirectDelete,
    stop: &dyn Fn(&SessionEntry),
) -> Result<Deleted> {
    let entry = index::get(session_id).map_err(err)?;
    let worktree = remove_worktree.then(|| entry.worktree_name.clone()).flatten().filter(|_| !entry.worktree_removed);
    let worktree = match worktree.as_deref().map(|name| worktree_target(&entry, name)).transpose()? {
        Some(WorktreeTarget::Managed(name)) => Some(name),
        Some(WorktreeTarget::ElsewhereOnDisk) => return Err(elsewhere_error(&entry)),
        // Its checkout is already gone, and a directory of the same name
        // under the current worktree folder is not this session's: only the
        // session is deleted.
        Some(WorktreeTarget::ElsewhereGone) | None => None,
    };
    let doomed = if worktree.is_some() { sessions_in_workspace(Path::new(&entry.cwd))? } else { vec![entry.clone()] };
    for session in &doomed {
        stop(session);
    }
    let mut removal = git::WorktreeRemoval::default();
    if let Some(name) = worktree.as_deref() {
        removal = git::remove_worktree(Path::new(&entry.project_path), name, direct).map_err(err)?;
    }
    remove_session_entries(&doomed)?;
    if worktree.is_some() {
        notify_workspace_deleted(sink, &entry.project_path, &doomed);
    } else {
        notify_sessions_deleted(sink, &doomed);
    }
    Ok(Deleted { sessions: doomed, removal })
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

    #[test]
    fn deleting_a_session_removes_its_agent_data_and_removing_only_the_worktree_does_not() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let sink = crate::sink::BroadcastSink::new(16);
        let stop = |_: &SessionEntry| {};

        // The worktree goes but the session is kept: resume still needs the transcript.
        let kept = worktree_session(dir.path());
        let transcript = claude_transcript(&kept, "22222222-2222-4222-8222-222222222222");
        git::remove_worktree(Path::new(&kept.project_path), kept.worktree_name.as_deref().unwrap(), git::DirectDelete::Allowed).unwrap();
        assert!(transcript.exists());

        // The session goes: so does the folder for its removed worktree.
        let doomed = worktree_session(dir.path());
        let transcript = claude_transcript(&doomed, CONVERSATION);
        delete_session_blocking(&sink, &doomed.id, true, git::DirectDelete::Allowed, &stop).unwrap();
        assert!(!Path::new(&doomed.cwd).exists());
        assert!(!transcript.parent().unwrap().exists());
    }

    #[test]
    fn a_failed_delete_leaves_the_agent_data_alone() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let sink = crate::sink::BroadcastSink::new(16);
        let session = worktree_session(dir.path());
        let transcript = claude_transcript(&session, CONVERSATION);
        let locked = ReadOnly::new(Path::new(&session.cwd));
        assert!(delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, &|_| {}).is_err());
        drop(locked);
        assert!(transcript.exists());
    }

    #[test]
    fn a_worktree_outside_the_current_worktree_folder_is_not_silently_orphaned() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let sink = crate::sink::BroadcastSink::new(16);
        let session = worktree_session(dir.path());
        // The worktree folder setting changes after the session was made.
        let settings = crate::store::settings::Settings { worktree_dir: ".elsewhere".into(), ..Default::default() };
        crate::store::settings::save(&settings).unwrap();

        let error = delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, &|_| {}).unwrap_err();
        assert!(error.contains(&session.cwd), "{error}");
        assert!(Path::new(&session.cwd).join("a.txt").exists());
        assert!(index::get(&session.id).is_ok(), "the session still points at its checkout");
    }

    #[test]
    fn a_same_named_directory_is_never_removed_for_a_session_whose_checkout_is_elsewhere_and_gone() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let sink = crate::sink::BroadcastSink::new(16);
        let session = worktree_session(dir.path());
        let name = session.worktree_name.clone().unwrap();
        // The session's own checkout goes away, and the worktree folder
        // setting changes to a place that holds a directory of the same name.
        git::run(dir.path(), &["worktree", "remove", "--force", &session.cwd]).unwrap();
        let settings = crate::store::settings::Settings { worktree_dir: ".elsewhere".into(), ..Default::default() };
        crate::store::settings::save(&settings).unwrap();
        let look_alike = git::worktree_path(dir.path(), &name);
        std::fs::create_dir_all(&look_alike).unwrap();
        std::fs::write(look_alike.join("not-the-sessions.txt"), "keep").unwrap();
        assert_eq!(worktree_target(&session, &name).unwrap(), WorktreeTarget::ElsewhereGone);

        let stopped = std::cell::Cell::new(0);
        let deleted = delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, &|_| stopped.set(stopped.get() + 1)).unwrap();
        assert_eq!(deleted.sessions.len(), 1);
        assert!(index::get(&session.id).is_err(), "only the session is deleted");
        assert!(look_alike.join("not-the-sessions.txt").exists(), "the same-named directory is not the session's");
        assert!(git::worktree_branch_names(dir.path()).contains(&name), "nor is the branch removed by name");
    }

    #[test]
    fn a_caller_that_showed_nothing_never_deletes_a_broken_worktree_directly() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let sink = crate::sink::BroadcastSink::new(16);
        let session = worktree_session(dir.path());
        std::fs::write(Path::new(&session.cwd).join("unsaved.txt"), "x").unwrap();
        std::fs::remove_file(Path::new(&session.cwd).join(".git")).unwrap();

        assert!(delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Never, &|_| {}).is_err());
        assert!(Path::new(&session.cwd).join("unsaved.txt").exists());
        assert!(index::get(&session.id).is_ok());

        // The desktop, after its confirmation, may.
        delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists());
    }

    #[test]
    fn the_sessions_sharing_a_worktree_are_the_ones_the_delete_takes() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let sink = crate::sink::BroadcastSink::new(16);
        let session = worktree_session(dir.path());
        let in_worktree = |cwd: String| {
            create_session_entry(NewSession {
                project_path: dir.path().to_string_lossy().into_owned(),
                title: Some("Companion".into()),
                use_worktree: false,
                base_ref: None,
                worktree_name: None,
                on_main: false,
                issue: None,
                automation: None,
                cwd: Some(cwd),
                tab: None,
            })
            .unwrap()
        };
        // Recorded through a path that is not the canonical one.
        let companion = in_worktree(format!("{}/.", session.cwd));
        let at_root = in_worktree(dir.path().to_string_lossy().into_owned());

        let shared = sessions_sharing_worktree(&session.id).unwrap();
        assert_eq!(shared.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec![companion.id.as_str()]);
        assert!(sessions_sharing_worktree(&at_root.id).unwrap().is_empty(), "a session with no worktree takes nothing along");

        let mut deleted: Vec<String> = delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, &|_| {}).unwrap().sessions.into_iter().map(|s| s.id).collect();
        deleted.sort();
        let mut expected = vec![session.id.clone(), companion.id.clone()];
        expected.sort();
        assert_eq!(deleted, expected);
    }

    #[test]
    fn a_worktree_that_cannot_be_removed_keeps_its_session_and_says_why() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let sink = crate::sink::BroadcastSink::new(16);
        let session = worktree_session(dir.path());
        let worktree = PathBuf::from(&session.cwd);
        let companion = create_session_entry(NewSession {
            project_path: dir.path().to_string_lossy().into_owned(),
            title: None,
            use_worktree: false,
            base_ref: None,
            worktree_name: None,
            on_main: false,
            issue: None,
            automation: None,
            cwd: Some(session.cwd.clone()),
            tab: None,
        })
        .unwrap();
        let stopped = std::cell::Cell::new(0);
        let stop = |_: &SessionEntry| stopped.set(stopped.get() + 1);

        let locked = ReadOnly::new(&worktree);
        let error = delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, &stop).unwrap_err();
        assert!(error.contains(&session.cwd), "the message names the directory: {error}");
        assert_eq!(stopped.get(), 2, "every session in the worktree is stopped before the removal is tried");
        assert!(worktree.join("a.txt").exists());
        assert!(index::get(&session.id).is_ok(), "the session still points at the leftover worktree");
        assert!(index::get(&companion.id).is_ok());

        // Once whatever held the directory lets go, the same delete works.
        drop(locked);
        let removed = delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, &stop).unwrap();
        assert_eq!(removed.sessions.len(), 2);
        assert_eq!(removed.removal, git::WorktreeRemoval::default());
        assert!(!worktree.exists());
        assert!(index::load().unwrap().is_empty());
    }
}
