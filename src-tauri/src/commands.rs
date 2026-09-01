//! Tauri commands. Thin: validate, call a module, map the error to a string.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};
use crate::store::projects::{self, Project};
use crate::{git, harness, names, store};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

// ------------------------------------------------------------------ projects

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsResponse {
    pub projects: Vec<Project>,
    pub last_selected: Option<String>,
}

#[tauri::command]
pub fn list_projects() -> CmdResult<ProjectsResponse> {
    let (projects, last_selected) = projects::list().map_err(err)?;
    Ok(ProjectsResponse { projects, last_selected })
}

#[tauri::command]
pub fn add_project(path: String) -> CmdResult<Project> {
    if !git::is_repo(Path::new(&path)) {
        return Err("That folder is not a git repository.".into());
    }
    projects::add(&path).map_err(err)
}

#[tauri::command]
pub fn remove_project(path: String) -> CmdResult<()> {
    projects::remove(&path).map_err(err)
}

#[tauri::command]
pub fn select_project(path: String) -> CmdResult<()> {
    projects::set_last_selected(&path).map_err(err)
}

// ------------------------------------------------------------------ sessions

#[tauri::command]
pub fn list_sessions() -> CmdResult<Vec<SessionEntry>> {
    index::load().map_err(err)
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub project_path: String,
    #[serde(default)]
    pub title: Option<String>,
    pub use_worktree: bool,
    #[serde(default)]
    pub base_ref: Option<String>,
    pub tab: NewTab,
}

fn new_tab_entry(t: &NewTab) -> TabEntry {
    TabEntry {
        id: uuid::Uuid::now_v7().to_string(),
        harness: t.harness.clone(),
        title: None,
        model: t.model.clone(),
        effort: t.effort.clone(),
        permission_mode: t.permission_mode.clone().unwrap_or_else(|| "auto".into()),
        provider_session_id: None,
        status: TabStatus::Idle,
        created: index::now(),
        modified: index::now(),
        context_used: None,
        context_max: None,
        unknown: BTreeMap::new(),
    }
}

/// Create a session: a worktree (unless opted out), an index entry, and its
/// first tab. The index entry lands before anything else can fail after it, so
/// a session whose agent never starts is still visible and deletable.
#[tauri::command]
pub async fn create_session(app: AppHandle, req: NewSession) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || create_session_blocking(&app, req))
        .await
        .map_err(err)?
}

fn create_session_blocking(app: &AppHandle, req: NewSession) -> CmdResult<SessionEntry> {
    let project = projects::canonical(&req.project_path).map_err(err)?;
    let project_path = Path::new(&project);
    let id = uuid::Uuid::now_v7().to_string();
    let now = index::now();
    let title = req.title.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "New session".into());

    let mut entry = SessionEntry {
        id: id.clone(),
        project_path: project.clone(),
        cwd: project.clone(),
        worktree_name: None,
        branch: git::current_branch(project_path),
        base_ref: None,
        worktree_removed: false,
        title,
        created: now.clone(),
        modified: now,
        archived: false,
        pinned: false,
        tabs: vec![new_tab_entry(&req.tab)],
        active_tab: None,
        unknown: BTreeMap::new(),
    };
    entry.active_tab = Some(entry.tabs[0].id.clone());

    if req.use_worktree {
        let taken = index::load().map(|s| index::claimed_worktree_names(&s)).unwrap_or_default();
        let taken = git::taken_worktree_names(project_path, &taken);
        let name = names::unclaimed(&taken);
        let wt = git::create_worktree(project_path, &name, req.base_ref.as_deref()).map_err(err)?;
        entry.cwd = wt.path;
        entry.worktree_name = Some(wt.name);
        entry.branch = Some(wt.branch);
        entry.base_ref = Some(wt.base_tree);
    }

    index::update(|sessions| {
        sessions.push(entry.clone());
        Ok(())
    })
    .map_err(err)?;
    let _ = app.emit("session_created", &entry);
    Ok(entry)
}

#[tauri::command]
pub fn add_tab(session_id: String, tab: NewTab) -> CmdResult<TabEntry> {
    let t = new_tab_entry(&tab);
    let out = t.clone();
    index::update_session(&session_id, |s| {
        s.tabs.push(t);
        s.active_tab = Some(out.id.clone());
        Ok(())
    })
    .map_err(err)?;
    Ok(out)
}

#[tauri::command]
pub fn remove_tab(app: AppHandle, session_id: String, tab_id: String) -> CmdResult<()> {
    let state = app.state::<crate::AppState>();
    state.host.kill(&format!("{session_id}/{tab_id}"));
    index::update_session(&session_id, |s| {
        s.tabs.retain(|t| t.id != tab_id);
        if s.active_tab.as_deref() == Some(&tab_id) {
            s.active_tab = s.tabs.last().map(|t| t.id.clone());
        }
        Ok(())
    })
    .map_err(err)?;
    if let Ok(p) = store::log_path(&session_id, &tab_id) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[tauri::command]
pub fn rename_session(session_id: String, title: String) -> CmdResult<()> {
    index::update_session(&session_id, |s| {
        s.title = title;
        Ok(())
    })
    .map_err(err)
}

#[tauri::command]
pub fn set_session_archived(session_id: String, archived: bool) -> CmdResult<()> {
    index::update_session(&session_id, |s| {
        s.archived = archived;
        Ok(())
    })
    .map_err(err)
}

#[tauri::command]
pub fn set_session_pinned(session_id: String, pinned: bool) -> CmdResult<()> {
    index::update_session(&session_id, |s| {
        s.pinned = pinned;
        Ok(())
    })
    .map_err(err)
}

#[tauri::command]
pub fn set_active_tab(session_id: String, tab_id: String) -> CmdResult<()> {
    index::update_session(&session_id, |s| {
        if s.tab(&tab_id).is_some() {
            s.active_tab = Some(tab_id);
        }
        Ok(())
    })
    .map_err(err)
}

/// Delete a session, its logs, attachments and (best effort) its worktree.
#[tauri::command]
pub async fn delete_session(app: AppHandle, session_id: String, remove_worktree: bool) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let entry = index::get(&session_id).map_err(err)?;
        for t in &entry.tabs {
            state.host.kill(&format!("{}/{}", entry.id, t.id));
        }
        index::update(|sessions| {
            sessions.retain(|s| s.id != session_id);
            Ok(())
        })
        .map_err(err)?;
        if let Ok(dir) = store::sessions_dir() {
            let _ = std::fs::remove_dir_all(dir.join(&session_id));
        }
        if let Ok(root) = store::root() {
            let _ = std::fs::remove_dir_all(root.join("attachments").join(&session_id));
        }
        if remove_worktree {
            if let Some(name) = entry.worktree_name.as_deref() {
                if let Err(e) = git::remove_worktree(Path::new(&entry.project_path), name) {
                    log::warn!("worktree cleanup for {session_id} failed: {e:#}");
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(err)?
}

// ------------------------------------------------------------------ harnesses

#[tauri::command]
pub async fn list_harnesses() -> CmdResult<Vec<harness::HarnessInfo>> {
    tauri::async_runtime::spawn_blocking(harness::catalog).await.map_err(err)
}

// ------------------------------------------------------------------ git

#[tauri::command]
pub async fn work_status(cwd: String) -> CmdResult<git::WorkStatus> {
    tauri::async_runtime::spawn_blocking(move || git::work_status(Path::new(&cwd))).await.map_err(err)
}

#[tauri::command]
pub async fn list_branches(cwd: String) -> CmdResult<Vec<git::BranchInfo>> {
    tauri::async_runtime::spawn_blocking(move || git::list_branches(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn worktree_disposition(session_id: String) -> CmdResult<git::WorktreeDisposition> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = index::get(&session_id).map_err(err)?;
        Ok(match s.worktree_name.as_deref() {
            Some(name) if !s.worktree_removed => git::worktree_disposition(Path::new(&s.project_path), name),
            _ => git::WorktreeDisposition::default(),
        })
    })
    .await
    .map_err(err)?
}

/// Remove a session's worktree and point the session at the project root. The
/// branch stays recorded so the PR panel can keep following it.
#[tauri::command]
pub async fn remove_session_worktree(app: AppHandle, session_id: String) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let s = index::get(&session_id).map_err(err)?;
        let name = s.worktree_name.clone().ok_or("session has no worktree")?;
        for t in &s.tabs {
            state.host.kill(&format!("{}/{}", s.id, t.id));
        }
        git::remove_worktree(Path::new(&s.project_path), &name).map_err(err)?;
        let out = index::update_session(&session_id, |s| {
            s.cwd = s.project_path.clone();
            s.worktree_name = None;
            s.worktree_removed = true;
            Ok(s.clone())
        })
        .map_err(err)?;
        let _ = app.emit("session_updated", &out);
        Ok(out)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn snapshot_tree(cwd: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || git::snapshot_tree(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn head_tree(cwd: String) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&cwd);
        if !git::is_repo(p) {
            return Ok(None);
        }
        git::head_tree(p).map(Some).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn changes_between(cwd: String, base: String, head: Option<String>) -> CmdResult<Vec<git::ChangedFile>> {
    tauri::async_runtime::spawn_blocking(move || git::changes_between(Path::new(&cwd), &base, head.as_deref()).map_err(err))
        .await
        .map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePair {
    pub before: Option<String>,
    pub after: Option<String>,
}

#[tauri::command]
pub async fn file_contents_at(cwd: String, path: String, base: String, head: Option<String>) -> CmdResult<FilePair> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&cwd);
        let before = git::blob_at(p, &base, &path).map_err(err)?;
        let after = match head {
            Some(h) => git::blob_at(p, &h, &path).map_err(err)?,
            None => git::working_file(p, &path),
        };
        Ok(FilePair { before, after })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn log_commits(cwd: String, range: Option<String>, limit: Option<u32>) -> CmdResult<Vec<git::CommitInfo>> {
    tauri::async_runtime::spawn_blocking(move || git::log_commits(Path::new(&cwd), range.as_deref(), limit.unwrap_or(100)).map_err(err))
        .await
        .map_err(err)?
}

// ------------------------------------------------------------------ agents (tabs)

use crate::session::{ImageInput, QueuedMessage, SendOutcome};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn load_tab_events(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Vec<crate::events::AgentEvent>> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.load_events(&session_id, &tab_id).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    text: String,
    images: Option<Vec<ImageInput>>,
) -> CmdResult<SendOutcome> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.send(&session_id, &tab_id, text, images.unwrap_or_default()).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn interrupt_turn(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.interrupt(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn stop_tab(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.stop(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn cancel_queued(state: State<'_, AppState>, session_id: String, tab_id: String, message_id: String) -> CmdResult<Option<QueuedMessage>> {
    state.manager().ok_or("not ready")?.cancel_queued(&session_id, &tab_id, &message_id).map_err(err)
}

#[tauri::command]
pub fn list_queued(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Vec<QueuedMessage>> {
    Ok(state.manager().ok_or("not ready")?.queued(&session_id, &tab_id))
}

#[tauri::command]
pub fn respond_permission(state: State<'_, AppState>, session_id: String, tab_id: String, request_id: String, option_id: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.respond_permission(&session_id, &tab_id, &request_id, &option_id).map_err(err)
}

#[tauri::command]
pub fn answer_questions(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
    request_id: String,
    answers: std::collections::HashMap<String, String>,
) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.answer_questions(&session_id, &tab_id, &request_id, answers).map_err(err)
}

#[tauri::command]
pub fn set_tab_model(state: State<'_, AppState>, session_id: String, tab_id: String, model: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.set_model(&session_id, &tab_id, &model).map_err(err)
}

#[tauri::command]
pub fn set_tab_permission_mode(state: State<'_, AppState>, session_id: String, tab_id: String, mode: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.set_permission_mode(&session_id, &tab_id, &mode).map_err(err)
}

#[tauri::command]
pub fn set_tab_effort(state: State<'_, AppState>, session_id: String, tab_id: String, effort: Option<String>) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.set_effort(&session_id, &tab_id, effort.as_deref()).map_err(err)
}

#[tauri::command]
pub fn mark_tab_read(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.mark_read(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn tab_status(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<TabStatus> {
    Ok(state.manager().ok_or("not ready")?.status_of(&session_id, &tab_id))
}

#[tauri::command]
pub fn list_models() -> Vec<crate::models::Model> {
    crate::models::catalog()
}

#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    if level == "error" {
        log::error!("[webview] {message}");
    } else {
        log::info!("[webview] {message}");
    }
}

// ------------------------------------------------------------------ files & commands

#[tauri::command]
pub async fn search_files(cwd: String, query: String, limit: Option<usize>) -> CmdResult<Vec<crate::files::FileHit>> {
    tauri::async_runtime::spawn_blocking(move || crate::files::search(Path::new(&cwd), &query, limit.unwrap_or(40)).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn invalidate_file_index(cwd: String) {
    crate::files::invalidate(Path::new(&cwd));
}

#[tauri::command]
pub async fn list_slash_commands(cwd: String, harness: String) -> CmdResult<Vec<harness::claude::commands::SlashCommand>> {
    if harness != "claude" {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || harness::claude::commands::list(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub media_type: String,
    pub data: String,
    pub name: String,
}

/// Read an image the reader dropped or picked, as base64 for the wire.
#[tauri::command]
pub async fn read_image_file(path: String) -> CmdResult<Option<ImageFile>> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let media = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => return Ok(None),
        };
        let meta = std::fs::metadata(p).map_err(err)?;
        if meta.len() > 5 * 1024 * 1024 {
            return Ok(None);
        }
        use base64::Engine as _;
        let bytes = std::fs::read(p).map_err(err)?;
        Ok(Some(ImageFile {
            media_type: media.into(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        }))
    })
    .await
    .map_err(err)?
}

// ------------------------------------------------------------------ git actions & PRs

#[tauri::command]
pub async fn git_commit(cwd: String, message: String, paths: Option<Vec<String>>) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || git::commit_all(Path::new(&cwd), &message, paths.as_deref()).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn git_push(cwd: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || git::push(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn git_pull(cwd: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || git::pull(Path::new(&cwd)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn git_discard(cwd: String, path: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || git::discard_file(Path::new(&cwd), &path).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn git_checkout(cwd: String, name: String, create: bool) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || git::checkout_branch(Path::new(&cwd), &name, create).map_err(err)).await.map_err(err)?
}

/// Uncommitted changes: HEAD's tree against a snapshot of the checkout. The
/// snapshot (not `git diff <tree>`) is what makes untracked files count.
#[tauri::command]
pub async fn working_changes(cwd: String) -> CmdResult<(String, Vec<git::ChangedFile>)> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&cwd);
        let head = git::head_tree(p).map_err(err)?;
        let snapshot = git::snapshot_tree(p).map_err(err)?;
        let files = if head == snapshot { Vec::new() } else { git::changes_between(p, &head, Some(&snapshot)).map_err(err)? };
        Ok((head, files))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pr_list(cwd: String, branch: String) -> CmdResult<Vec<crate::github::PullRequest>> {
    tauri::async_runtime::spawn_blocking(move || crate::github::prs_for_branch(Path::new(&cwd), &branch).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_create(cwd: String, title: String, body: String, base: Option<String>, draft: bool) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || crate::github::create_pr(Path::new(&cwd), &title, &body, base.as_deref(), draft).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn pr_merge(cwd: String, number: u64, method: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::github::merge_pr(Path::new(&cwd), number, &method).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn pr_ready(cwd: String, number: u64) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::github::mark_ready(Path::new(&cwd), number).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn gh_available() -> bool {
    crate::github::available()
}
