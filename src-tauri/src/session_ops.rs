//! Session index operations shared by the Tauri commands, the control socket
//! and the headless runtime: creating a session (and its worktree) and telling
//! listeners when sessions or workspaces go away.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::sink::EventSink;
use crate::store::index::{self, AutomationRef, IssueRef, SessionEntry, TabEntry, TabStatus};
use crate::store::projects;
use crate::{git, names, store};

type Result<T> = std::result::Result<T, String>;

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
    let claimed = index::load().map(|sessions| index::claimed_worktree_names(&sessions)).unwrap_or_default();
    let mut taken = git::taken_worktree_names(project, &claimed);
    if let Some(excluding) = excluding {
        taken.retain(|name| name != excluding);
    }
    match requested.filter(|name| !name.trim().is_empty()) {
        Some(requested) => names::requested(requested, &taken)
            .ok_or_else(|| "Workspace names must contain at least one letter or number.".into()),
        None => Ok(names::unclaimed(&taken)),
    }
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
    validate_session_target(&req)?;
    let project = projects::canonical_directory(&req.project_path).map_err(err)?;
    let project_path = Path::new(&project);
    let id = uuid::Uuid::now_v7().to_string();
    let now = index::now();
    let requested_title = req.title.clone().filter(|t| !t.trim().is_empty());
    let first_tab = req.tab.as_ref().map(new_tab_entry);
    let has_agent = first_tab.is_some();

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
        entry.branch = git::current_branch(Path::new(&cwd));
        entry.cwd = cwd;
    } else if has_agent && req.use_worktree && git::is_repo(project_path) {
        let name = available_worktree_name(project_path, req.worktree_name.as_deref(), None)?;
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

/// Delete a workspace together with every session that ran in it: index
/// entries, transcript logs and attachments. Returns the removed sessions so
/// callers can announce them. Tabs must already be stopped.
pub(crate) fn delete_workspace_entries(project_path: &str, path: &str, delete_branch: bool, direct: git::DirectDelete) -> Result<Vec<SessionEntry>> {
    let project = std::fs::canonicalize(project_path).unwrap_or_else(|_| PathBuf::from(project_path));
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let affected = sessions_in_workspace(&target)?;
    crate::workspaces::delete(&project, &target, delete_branch, direct).map_err(err)?;
    remove_session_entries(&affected)?;
    Ok(affected)
}

/// Drop sessions from the index along with their transcript logs and
/// attachments. Callers stop whatever the tabs were running first.
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
    /// The worktree's branch, when it was kept because it holds commits
    /// nothing else has (see [`git::remove_worktree`]).
    pub kept_branch: Option<String>,
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
/// `direct` says whether a directory git cannot remove may be deleted
/// directly. Callers that did not show the person what would be lost pass
/// [`git::DirectDelete::Never`].
pub(crate) fn delete_session_blocking(
    sink: &dyn EventSink,
    session_id: &str,
    remove_worktree: bool,
    direct: git::DirectDelete,
    stop: &dyn Fn(&SessionEntry),
) -> Result<Deleted> {
    let entry = index::get(session_id).map_err(err)?;
    let worktree = remove_worktree.then(|| entry.worktree_name.clone()).flatten().filter(|_| !entry.worktree_removed);
    if let Some(name) = worktree.as_deref() {
        // The worktree is removed by name, under the worktree folder as it is
        // set now. If the session's checkout is somewhere else (the setting
        // changed since), removing by name would find nothing, report
        // success and orphan the real directory.
        let managed = git::managed_worktree_path(Path::new(&entry.project_path), name).map_err(err)?;
        let cwd = Path::new(&entry.cwd);
        let same = std::fs::canonicalize(cwd).ok().zip(std::fs::canonicalize(&managed).ok()).map(|(a, b)| a == b).unwrap_or(cwd == managed);
        if !same && std::fs::symlink_metadata(cwd).is_ok() {
            return Err(format!(
                "The worktree at {} is not in this project's worktree folder ({}), so it was not removed and the session was kept. Delete the workspace from the sidebar instead.",
                entry.cwd,
                git::worktree_root(Path::new(&entry.project_path)).display()
            ));
        }
    }
    let doomed = if worktree.is_some() { sessions_in_workspace(Path::new(&entry.cwd))? } else { vec![entry.clone()] };
    for session in &doomed {
        stop(session);
    }
    let mut kept_branch = None;
    if let Some(name) = worktree.as_deref() {
        kept_branch = git::remove_worktree(Path::new(&entry.project_path), name, direct).map_err(err)?.kept_branch;
    }
    remove_session_entries(&doomed)?;
    if worktree.is_some() {
        notify_workspace_deleted(sink, &entry.project_path, &doomed);
    } else {
        notify_sessions_deleted(sink, &doomed);
    }
    Ok(Deleted { sessions: doomed, kept_branch })
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
        assert_eq!(removed.kept_branch, None);
        assert!(!worktree.exists());
        assert!(index::load().unwrap().is_empty());
    }
}
