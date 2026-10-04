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
fn mark_workspace_sessions_removed(project: &Path, affected: &[SessionEntry]) -> Result<Vec<SessionEntry>> {
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
