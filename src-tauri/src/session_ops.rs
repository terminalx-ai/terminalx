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

static WORKSPACE_LIFECYCLE: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    let _guard = WORKSPACE_LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
    validate_session_target(&req)?;
    let project = projects::canonical_directory(&req.project_path).map_err(err)?;
    projects::refuse_mirror(&project).map_err(err)?;
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
        projects::refuse_mirror(&cwd).map_err(err)?;
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

/// Other owners of this workspace. Their presence prevents a session delete
/// from removing the checkout. Ownership is matched by canonical path.
pub(crate) fn sessions_sharing_worktree(session_id: &str) -> Result<Vec<SessionEntry>> {
    let entry = index::get(session_id).map_err(err)?;
    if entry.cwd == entry.project_path || entry.worktree_removed {
        return Ok(Vec::new());
    }
    Ok(sessions_in_workspace(Path::new(&entry.cwd))?.into_iter().filter(|session| session.id != entry.id).collect())
}

/// What happens to conversations when their workspace is removed.
#[derive(Clone, Copy)]
pub(crate) enum WorkspaceSessions<'a> {
    Delete,
    Keep,
    /// A session delete is allowed to remove only its own, now-empty workspace.
    DeleteOnly(&'a str),
}

pub(crate) fn workspace_disposition(project_path: &str, path: &str) -> Result<crate::workspaces::WorkspaceDisposition> {
    let mut d = crate::workspaces::disposition(Path::new(project_path), Path::new(path));
    let sessions = sessions_in_workspace(Path::new(path))?;
    d.sessions = sessions.len();
    d.session_titles = sessions.into_iter().map(|s| s.title).collect();
    Ok(d)
}

pub(crate) fn delete_workspace_entries(project_path: &str, path: &str, delete_branch: bool, direct: git::DirectDelete, confirmed_unsafe: bool, stop: &dyn Fn(&SessionEntry)) -> Result<(Vec<SessionEntry>, git::WorktreeRemoval)> {
    remove_workspace_entries(project_path, path, delete_branch, direct, confirmed_unsafe, WorkspaceSessions::Delete, stop)
}

/// The one removal path: verify, remove the checkout, then update its owned
/// sessions. Settlement retains their conversations at the project root.
pub(crate) fn remove_workspace_entries(project_path: &str, path: &str, delete_branch: bool, direct: git::DirectDelete, confirmed_unsafe: bool, mode: WorkspaceSessions<'_>, stop: &dyn Fn(&SessionEntry)) -> Result<(Vec<SessionEntry>, git::WorktreeRemoval)> {
    let _guard = WORKSPACE_LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
    let project = std::fs::canonicalize(project_path).unwrap_or_else(|_| PathBuf::from(project_path));
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let affected = sessions_in_workspace(&target)?;
    if let WorkspaceSessions::DeleteOnly(id) = mode {
        if affected.iter().any(|s| s.id != id) {
            return Err(format!("The workspace at {path} is shared by other sessions. Delete only this session, or use Delete workspace to remove all of them."));
        }
    }
    for session in &affected { stop(session); }
    let removal = crate::workspaces::delete(&project, &target, delete_branch, direct, confirmed_unsafe).map_err(err)?;
    let sessions = match mode {
        WorkspaceSessions::Keep => {
            let ids: std::collections::HashSet<_> = affected.iter().map(|s| s.id.as_str()).collect();
            let branch = git::current_branch(&project);
            index::update(|sessions| {
                let mut moved = Vec::new();
                for s in sessions.iter_mut().filter(|s| ids.contains(s.id.as_str())) {
                    index::mark_workspace_removed(s, branch.clone());
                    s.modified = index::now();
                    moved.push(s.clone());
                }
                Ok(moved)
            }).map_err(err)?
        }
        _ => { remove_session_entries(&affected)?; affected }
    };
    Ok((sessions, removal))
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

/// Delete exactly one session. Removing its workspace is an explicit choice
/// and is rejected if any other session still owns that workspace.
pub(crate) fn delete_session_blocking(
    sink: &dyn EventSink,
    session_id: &str,
    remove_worktree: bool,
    direct: git::DirectDelete,
    confirmed_unsafe: bool,
    stop: &dyn Fn(&SessionEntry),
) -> Result<Deleted> {
    let entry = index::get(session_id).map_err(err)?;
    let has_workspace = !entry.worktree_removed && Path::new(&entry.cwd) != Path::new(&entry.project_path);
    if remove_worktree && has_workspace && std::fs::symlink_metadata(&entry.cwd).is_ok() {
        if !sessions_sharing_worktree(session_id)?.is_empty() {
            return Err(format!("The workspace at {} is shared by other sessions. Delete only this session, or use Delete workspace.", entry.cwd));
        }
        let (sessions, removal) = remove_workspace_entries(&entry.project_path, &entry.cwd, true, direct, confirmed_unsafe, WorkspaceSessions::DeleteOnly(session_id), stop)?;
        notify_workspace_deleted(sink, &entry.project_path, &sessions);
        Ok(Deleted { sessions, removal })
    } else {
        stop(&entry);
        remove_session_entries(std::slice::from_ref(&entry))?;
        notify_sessions_deleted(sink, std::slice::from_ref(&entry));
        Ok(Deleted { sessions: vec![entry], removal: git::WorktreeRemoval::default() })
    }
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
        delete_session_blocking(&sink, &doomed.id, true, git::DirectDelete::Allowed, true, &stop).unwrap();
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
        assert!(delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, true, &|_| {}).is_err());
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

        delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, true, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists());
        assert!(index::get(&session.id).is_err());
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

        let stopped = std::cell::Cell::new(0);
        let deleted = delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, true, &|_| stopped.set(stopped.get() + 1)).unwrap();
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

        assert!(delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Never, false, &|_| {}).is_err());
        assert!(Path::new(&session.cwd).join("unsaved.txt").exists());
        assert!(index::get(&session.id).is_ok());

        // The desktop, after its confirmation, may.
        delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, true, &|_| {}).unwrap();
        assert!(!Path::new(&session.cwd).exists());
    }

    #[test]
    fn deleting_one_session_never_deletes_a_companion() {
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

        assert!(delete_session_blocking(&sink, &session.id, true, git::DirectDelete::Allowed, true, &|_| {}).unwrap_err().contains("shared"));
        assert!(index::get(&session.id).is_ok());
        assert!(index::get(&companion.id).is_ok());
        let deleted = delete_session_blocking(&sink, &session.id, false, git::DirectDelete::Allowed, false, &|_| {}).unwrap();
        assert_eq!(deleted.sessions.len(), 1);
        assert!(index::get(&companion.id).is_ok());
        assert!(Path::new(&companion.cwd).exists());
    }

    #[test]
    fn a_worktree_that_cannot_be_removed_keeps_its_session_and_says_why() {
        let _home = crate::store::temp_home();
        let dir = repo();
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
        let error = delete_workspace_entries(&session.project_path, &session.cwd, true, git::DirectDelete::Allowed, true, &stop).unwrap_err();
        assert!(error.contains(&session.cwd), "the message names the directory: {error}");
        assert_eq!(stopped.get(), 2, "every session in the worktree is stopped before the removal is tried");
        assert!(worktree.join("a.txt").exists());
        assert!(index::get(&session.id).is_ok(), "the session still points at the leftover worktree");
        assert!(index::get(&companion.id).is_ok());

        // Once whatever held the directory lets go, the same delete works.
        drop(locked);
        let (removed, removal) = delete_workspace_entries(&session.project_path, &session.cwd, true, git::DirectDelete::Allowed, true, &stop).unwrap();
        assert_eq!(removed.len(), 2);
        assert_eq!(removal, git::WorktreeRemoval::default());
        assert!(!worktree.exists());
        assert!(index::load().unwrap().is_empty());
    }
    #[test]
    fn settlement_keeps_all_conversations_and_their_transcripts() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let session = worktree_session(dir.path());
        let companion = create_session_entry(NewSession {
            project_path: session.project_path.clone(), title: Some("Review".into()),
            use_worktree: false, base_ref: None, worktree_name: None, on_main: false,
            issue: None, automation: None, cwd: Some(session.cwd.clone()), tab: None,
        }).unwrap();
        let transcript = crate::store::log_path(&session.id, session.active_tab.as_deref().unwrap()).unwrap();
        std::fs::write(&transcript, "conversation").unwrap();
        let stopped = std::cell::Cell::new(0);
        let (kept, _) = remove_workspace_entries(&session.project_path, &session.cwd, true,
            git::DirectDelete::Allowed, true, WorkspaceSessions::Keep, &|_| stopped.set(stopped.get() + 1)).unwrap();
        assert_eq!(stopped.get(), 2);
        assert_eq!(kept.len(), 2);
        assert!(kept.iter().all(|s| s.worktree_removed && s.cwd == session.project_path));
        assert!(index::get(&companion.id).is_ok());
        assert!(transcript.exists());
        assert!(!Path::new(&session.cwd).exists());
    }

}
