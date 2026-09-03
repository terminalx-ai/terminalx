//! Tauri commands. Thin: validate, call a module, map the error to a string.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::index::{self, AutomationRef, IssueRef, SessionEntry, TabEntry, TabStatus};
use crate::store::projects::{self, Project};
use crate::{git, harness, names, store};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

/// Stop whatever a tab is running: a headless child, or the terminal pane a
/// PTY-first tab's own CLI lives in.
fn kill_tab(state: &tauri::State<'_, crate::AppState>, session_id: &str, tab_id: &str) {
    state.host.kill(&format!("{session_id}/{tab_id}"));
    state.terminals.kill(&crate::session::SessionManager::pane_id(tab_id));
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

// ---------------------------------------------------------------- automations

#[tauri::command]
pub fn automations_list() -> CmdResult<Vec<crate::automations::Automation>> {
    store::automations::list().map_err(err)
}

#[tauri::command]
pub fn automation_runs(automation_id: String) -> CmdResult<Vec<crate::automations::AutomationRun>> {
    store::automations::list_runs(&automation_id).map_err(err)
}

#[tauri::command]
pub fn automation_issue_states() -> CmdResult<Vec<crate::automations::AutomationIssueState>> {
    crate::automations::issue_states().map_err(err)
}

#[tauri::command]
pub async fn automation_issue_preview(project_path: String, repo: String, query: String) -> CmdResult<Vec<crate::issues::Issue>> {
    tauri::async_runtime::spawn_blocking(move || crate::issues::github_search(Path::new(&project_path), &repo, &query, 50).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn automation_create(app: AppHandle, input: crate::automations::AutomationInput) -> CmdResult<crate::automations::Automation> {
    let mut input = input;
    input.project_path = projects::canonical(&input.project_path).map_err(err)?;
    validate_automation_target(&input)?;
    let automation = crate::automations::definition_from_input(input, None, chrono::Utc::now()).map_err(err)?;
    let automation = store::automations::insert(automation).map_err(err)?;
    crate::automations::emit_definitions(&app);
    Ok(automation)
}

#[tauri::command]
pub fn automation_update(app: AppHandle, id: String, input: crate::automations::AutomationInput) -> CmdResult<crate::automations::Automation> {
    let existing = store::automations::get(&id).map_err(err)?;
    let mut input = input;
    input.project_path = projects::canonical(&input.project_path).map_err(err)?;
    validate_automation_target(&input)?;
    let automation = crate::automations::definition_from_input(input, Some(&existing), chrono::Utc::now()).map_err(err)?;
    let reset_seen = match (&existing.issue_trigger, &automation.issue_trigger) {
        (Some(before), Some(after)) => {
            before.repo != after.repo
                || before.query != after.query
                || (!before.run_on_existing && after.run_on_existing)
        }
        (None, Some(_)) => true,
        _ => false,
    };
    let automation = store::automations::replace(automation).map_err(err)?;
    if reset_seen {
        store::automations::clear_seen(&id).map_err(err)?;
    }
    crate::automations::emit_definitions(&app);
    Ok(automation)
}

#[tauri::command]
pub fn automation_delete(app: AppHandle, id: String) -> CmdResult<()> {
    store::automations::remove(&id).map_err(err)?;
    crate::automations::emit_definitions(&app);
    Ok(())
}

fn validate_automation_target(input: &crate::automations::AutomationInput) -> CmdResult<()> {
    if input.workspace == crate::automations::AutomationWorkspace::Session {
        let target = index::get(input.session_id.as_deref().ok_or("Choose a session for this automation.")?).map_err(err)?;
        if projects::canonical(&target.project_path).map_err(err)? != input.project_path {
            return Err("The selected session belongs to another project.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn automation_run_now(app: AppHandle, id: String) -> CmdResult<crate::automations::AutomationRun> {
    tauri::async_runtime::spawn_blocking(move || crate::automations::dispatch(&app, &id, crate::automations::AutomationTrigger::Manual, None).map_err(err))
        .await
        .map_err(err)?
}

/// The snippets the agent dashboard draws on its cards. Reading tails off the
/// disk is blocking work, and the dashboard asks for every session at once, so
/// it runs off the UI thread.
#[tauri::command]
pub async fn session_summaries(session_ids: Option<Vec<String>>) -> CmdResult<Vec<crate::summaries::SessionSummary>> {
    tauri::async_runtime::spawn_blocking(move || crate::summaries::collect(session_ids).map_err(err))
        .await
        .map_err(err)?
}

/// App-owned activity and transcript-backed token analytics are disk-heavy on
/// the first scan, so keep them off the UI thread.
#[tauri::command]
pub async fn stats_usage_snapshot(state: State<'_, AppState>) -> CmdResult<crate::stats::StatsUsageSnapshot> {
    let stats = state.stats_usage.clone();
    tauri::async_runtime::spawn_blocking(move || stats.snapshot().map_err(err))
        .await
        .map_err(err)?
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

/// A worktree name the reader asked for, made safe for a branch and a folder:
/// lowercase, `[a-z0-9-]`, at most 40 chars, and suffixed when already taken.
fn requested_worktree_name(requested: &str, taken: &[String]) -> Option<String> {
    let mut base = String::new();
    let mut last_dash = true;
    for ch in requested.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            base.push(c);
            last_dash = false;
        } else if !last_dash {
            base.push('-');
            last_dash = true;
        }
        if base.len() >= 40 {
            break;
        }
    }
    let base = base.trim_matches('-').to_string();
    if base.is_empty() {
        return None;
    }
    if !taken.iter().any(|t| t == &base) {
        return Some(base);
    }
    (2..1000).map(|n| format!("{base}-{n}")).find(|c| !taken.iter().any(|t| t == c))
}

fn validate_session_target(req: &NewSession) -> CmdResult<()> {
    let requested_worktree = req.worktree_name.as_deref().is_some_and(|name| !name.trim().is_empty());
    if !req.use_worktree && requested_worktree && !req.on_main {
        return Err("A requested worktree can only be skipped when onMain is explicitly true.".into());
    }
    Ok(())
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
        fork_from: None,
        unknown: BTreeMap::new(),
    }
}

/// Create a session: an index entry around an existing checkout, or a new
/// worktree and its first tab. The index entry lands before anything else can
/// fail after it, so a session whose agent never starts is still visible and
/// deletable.
#[tauri::command]
pub async fn create_session(app: AppHandle, req: NewSession) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || create_session_blocking(&app, req))
        .await
        .map_err(err)?
}

pub(crate) fn create_session_blocking(app: &AppHandle, req: NewSession) -> CmdResult<SessionEntry> {
    let entry = create_session_entry(req)?;
    let _ = app.emit("session_created", &entry);
    Ok(entry)
}

fn create_session_entry(req: NewSession) -> CmdResult<SessionEntry> {
    validate_session_target(&req)?;
    let project = projects::canonical(&req.project_path).map_err(err)?;
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
        let cwd = projects::canonical(cwd).map_err(err)?;
        entry.branch = git::current_branch(Path::new(&cwd));
        entry.cwd = cwd;
    } else if has_agent && req.use_worktree {
        let taken = index::load().map(|s| index::claimed_worktree_names(&s)).unwrap_or_default();
        let taken = git::taken_worktree_names(project_path, &taken);
        let name = req
            .worktree_name
            .as_deref()
            .and_then(|r| requested_worktree_name(r, &taken))
            .unwrap_or_else(|| names::unclaimed(&taken));
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
    kill_tab(&state, &session_id, &tab_id);
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
            kill_tab(&state, &entry.id, &t.id);
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
    crate::binpath::invalidate();
    tauri::async_runtime::spawn_blocking(harness::offered).await.map_err(err)
}

// ------------------------------------------------------------------ skills

#[tauri::command]
pub async fn list_skills(project_path: Option<String>, refresh: bool) -> CmdResult<Vec<crate::skills::DiscoveredSkill>> {
    tauri::async_runtime::spawn_blocking(move || crate::skills::discover(project_path.as_deref(), refresh).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn skill_detail(dir_path: String) -> CmdResult<crate::skills::SkillDetail> {
    tauri::async_runtime::spawn_blocking(move || crate::skills::detail(Path::new(&dir_path)).map_err(err))
        .await
        .map_err(err)?
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
            kill_tab(&state, &s.id, &t.id);
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

/// Settle a worktree session once its work has landed: `delete` removes the
/// worktree and branch, `relocate` leaves them on disk; both move the session
/// to the project root, stopping any agent first.
#[tauri::command]
pub async fn settle_session(app: AppHandle, session_id: String, action: String) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let s = index::get(&session_id).map_err(err)?;
        let name = s.worktree_name.clone().ok_or("session has no worktree")?;
        for t in &s.tabs {
            kill_tab(&state, &s.id, &t.id);
        }
        let deleted = match action.as_str() {
            "delete" => {
                git::remove_worktree(Path::new(&s.project_path), &name).map_err(err)?;
                true
            }
            "relocate" => false,
            other => return Err(format!("unknown settle action {other}")),
        };
        let branch = git::current_branch(Path::new(&s.project_path));
        let out = index::update_session(&session_id, |s| {
            s.cwd = s.project_path.clone();
            s.worktree_name = None;
            s.worktree_removed = deleted;
            s.branch = branch.clone();
            s.base_ref = None;
            for t in &mut s.tabs {
                t.status = TabStatus::Idle;
            }
            Ok(s.clone())
        })
        .map_err(err)?;
        let _ = app.emit("session_updated", &out);
        Ok(out)
    })
    .await
    .map_err(err)?
}

/// Fork a tab into a new session: a fresh worktree at the source branch's
/// tip, the tab's log copied over so the history reads the same, and the
/// provider conversation forked on the first send.
#[tauri::command]
pub async fn fork_session(app: AppHandle, session_id: String, tab_id: String) -> CmdResult<SessionEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = index::get(&session_id).map_err(err)?;
        let tab = src.tab(&tab_id).cloned().ok_or("no such tab")?;
        let project_path = Path::new(&src.project_path);
        let id = uuid::Uuid::now_v7().to_string();
        let now = index::now();
        let mut new_tab = tab.clone();
        new_tab.id = uuid::Uuid::now_v7().to_string();
        new_tab.status = TabStatus::Idle;
        new_tab.created = now.clone();
        new_tab.modified = now.clone();
        // Claude can fork a conversation; Codex starts a new thread over the copied log.
        new_tab.fork_from = if tab.harness == "claude" { tab.provider_session_id.clone() } else { None };
        new_tab.provider_session_id = None;
        let mut entry = SessionEntry {
            id: id.clone(),
            project_path: src.project_path.clone(),
            cwd: src.cwd.clone(),
            worktree_name: None,
            branch: src.branch.clone(),
            base_ref: None,
            worktree_removed: false,
            issue: src.issue.clone(),
            automation: src.automation.clone(),
            title: format!("{} (fork)", src.title),
            created: now.clone(),
            modified: now,
            archived: false,
            pinned: false,
            tabs: vec![new_tab.clone()],
            active_tab: Some(new_tab.id.clone()),
            unknown: BTreeMap::new(),
        };
        if src.worktree_name.is_some() && !src.worktree_removed {
            let taken = index::load().map(|s| index::claimed_worktree_names(&s)).unwrap_or_default();
            let taken = git::taken_worktree_names(project_path, &taken);
            let name = names::unclaimed(&taken);
            let wt = git::create_worktree(project_path, &name, src.branch.as_deref()).map_err(err)?;
            entry.cwd = wt.path;
            entry.worktree_name = Some(wt.name);
            entry.branch = Some(wt.branch);
            entry.base_ref = Some(wt.base_tree);
        }
        // Copy the log, re-stamping envelopes so the new tab owns them.
        if let Ok(dir) = store::sessions_dir() {
            let from = dir.join(&src.id).join(format!("{}.jsonl", tab.id));
            if let Ok(text) = std::fs::read_to_string(&from) {
                let to_dir = dir.join(&id);
                let _ = std::fs::create_dir_all(&to_dir);
                let mut out = String::with_capacity(text.len());
                for line in text.lines() {
                    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(line) {
                        v["sessionId"] = serde_json::Value::String(id.clone());
                        v["tabId"] = serde_json::Value::String(new_tab.id.clone());
                        out.push_str(&v.to_string());
                        out.push('\n');
                    }
                }
                let _ = std::fs::write(to_dir.join(format!("{}.jsonl", new_tab.id)), out);
            }
        }
        if let Ok(root) = store::root() {
            let from = root.join("attachments").join(&src.id);
            if from.is_dir() {
                let to = root.join("attachments").join(&id);
                let _ = copy_dir(&from, &to);
            }
        }
        index::update(|sessions| {
            sessions.push(entry.clone());
            Ok(())
        })
        .map_err(err)?;
        let _ = app.emit("session_created", &entry);
        Ok(entry)
    })
    .await
    .map_err(err)?
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let dest = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else {
            std::fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
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
pub fn tab_handoff(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<crate::session::HandoffInfo> {
    state.manager().ok_or("not ready")?.handoff(&session_id, &tab_id).map_err(err)
}

/// The terminal pane a tab's CLI is running in, or nothing if it is not.
/// A window that opened after the CLI did never saw the pane announced.
#[tauri::command]
pub fn tab_pane(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<Option<crate::session::TabPtyEvent>> {
    Ok(state.manager().ok_or("not ready")?.pane_of(&session_id, &tab_id))
}

/// Start a tab's own CLI. PTY-first tabs are the CLI, so opening one starts
/// it; harnesses that still run headless do nothing here.
#[tauri::command]
pub async fn ensure_tab_started(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.ensure_started(&session_id, &tab_id).map_err(err)).await.map_err(err)?
}

/// Stopping and the three settings below all wait for the CLI in the pane to
/// really be gone before they answer, so none of them runs on the main thread.
#[tauri::command]
pub async fn stop_tab(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.stop(&session_id, &tab_id).map_err(err)).await.map_err(err)?
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
pub async fn set_tab_model(state: State<'_, AppState>, session_id: String, tab_id: String, model: String) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.set_model(&session_id, &tab_id, &model).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn set_tab_permission_mode(state: State<'_, AppState>, session_id: String, tab_id: String, mode: String) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.set_permission_mode(&session_id, &tab_id, &mode).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn set_tab_effort(state: State<'_, AppState>, session_id: String, tab_id: String, effort: Option<String>) -> CmdResult<()> {
    let m = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || m.set_effort(&session_id, &tab_id, effort.as_deref()).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn mark_tab_read(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<()> {
    state.manager().ok_or("not ready")?.mark_read(&session_id, &tab_id).map_err(err)
}

#[tauri::command]
pub fn tab_status(state: State<'_, AppState>, session_id: String, tab_id: String) -> CmdResult<TabStatus> {
    Ok(state.manager().ok_or("not ready")?.status_of(&session_id, &tab_id))
}

/// The picker's list. Everything but Codex is static; Codex depends on the
/// signed-in account, so it is read from the CLI and cached. `refresh` is what
/// the picker sends when it opens, so a model added (or retired) mid-session
/// shows up without a restart. Ordering and the hidden-harness filter both
/// live in `models::offered`.
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>, refresh: Option<bool>) -> CmdResult<Vec<crate::models::Model>> {
    let cache = state.codex_models.clone();
    let refresh = refresh.unwrap_or(false);
    let codex = tauri::async_runtime::spawn_blocking(move || cache.get(refresh)).await.map_err(err)?;
    Ok(crate::models::offered(codex))
}

#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[webview] {message}"),
        // Chatty by nature — a line per dictation result — so it sits at the
        // level a reader has to ask for.
        "debug" => log::debug!("[webview] {message}"),
        _ => log::info!("[webview] {message}"),
    }
}

// ------------------------------------------------------------------ status bar

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBarPatch {
    pub visible: Option<bool>,
    pub usage: Option<bool>,
    pub resources: Option<bool>,
    pub percent: Option<crate::store::settings::StatusPercent>,
    pub usage_mode: Option<crate::store::settings::StatusUsageMode>,
}

#[tauri::command]
pub fn status_bar_settings() -> crate::store::settings::StatusBarSettings {
    store::settings::load().status_bar
}

#[tauri::command]
pub fn set_status_bar_settings(app: AppHandle, patch: StatusBarPatch) -> CmdResult<crate::store::settings::StatusBarSettings> {
    let mut settings = store::settings::load();
    if let Some(value) = patch.visible {
        settings.status_bar.visible = value;
    }
    if let Some(value) = patch.usage {
        settings.status_bar.usage = value;
    }
    if let Some(value) = patch.resources {
        settings.status_bar.resources = value;
    }
    if let Some(value) = patch.percent {
        settings.status_bar.percent = value;
    }
    if let Some(value) = patch.usage_mode {
        settings.status_bar.usage_mode = value;
    }
    store::settings::save(&settings).map_err(err)?;
    crate::status::set_menu_checked(&app, settings.status_bar.visible);
    let _ = app.emit(crate::status::SETTINGS_EVENT, &settings.status_bar);
    Ok(settings.status_bar)
}

#[tauri::command]
pub fn status_usage_snapshot(state: State<'_, AppState>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    Ok(state.manager().ok_or("not ready")?.usage_snapshot())
}

#[tauri::command]
pub async fn status_usage_refresh(app: AppHandle, state: State<'_, AppState>, manual: Option<bool>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    let status = state.status.clone();
    let manager = state.manager().ok_or("not ready")?;
    let manual = manual.unwrap_or(false);
    let failures = tauri::async_runtime::spawn_blocking(move || {
        let mut failures = Vec::new();
        if let Err(error) = status.usage.refresh_claude() {
            failures.push(format!("Claude usage refresh: {error:#}"));
        }
        if let Err(error) = status.usage.refresh_codex(manual) {
            failures.push(format!("Codex usage refresh: {error:#}"));
        }
        failures
    })
    .await
    .map_err(err)?;
    for failure in failures {
        log::warn!("{failure}");
    }
    let snapshot = manager.usage_snapshot();
    let _ = app.emit(crate::status::usage::EVENT, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn status_codex_reset(app: AppHandle, state: State<'_, AppState>) -> CmdResult<crate::status::usage::UsageSnapshot> {
    let status = state.status.clone();
    let manager = state.manager().ok_or("not ready")?;
    tauri::async_runtime::spawn_blocking(move || status.usage.reset_codex().map_err(err)).await.map_err(err)??;
    let snapshot = manager.usage_snapshot();
    let _ = app.emit(crate::status::usage::EVENT, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn status_resource_overview(state: State<'_, AppState>) -> crate::status::resources::ResourceOverview {
    state.status.resources.overview(&state.terminals)
}

#[tauri::command]
pub async fn status_resource_sample(state: State<'_, AppState>) -> CmdResult<crate::status::resources::ResourceSnapshot> {
    let status = state.status.clone();
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || status.resources.sample(&terminals).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn status_resource_kill(
    state: State<'_, AppState>,
    pane_id: String,
    confirmed: Option<bool>,
) -> CmdResult<crate::status::resources::KillResult> {
    let status = state.status.clone();
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || status.resources.kill(&terminals, &pane_id, confirmed.unwrap_or(false)).map_err(err))
        .await
        .map_err(err)?
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

// ------------------------------------------------------------------ terminals

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<'_, AppState>, id: String, cwd: String, cols: u16, rows: u16, command: Option<String>) -> CmdResult<()> {
    let spec = crate::pty::PaneSpec { cwd: &cwd, cols: cols.max(2), rows: rows.max(1), command: command.as_deref(), env: &[] };
    state.terminals.spawn(app, &id, spec).map_err(err)
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    state.terminals.write(&id, data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    state.terminals.resize(&id, cols.max(2), rows.max(1)).map_err(err)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, id: String) {
    state.terminals.kill(&id);
}

// ------------------------------------------------------------------ files & editor

#[tauri::command]
pub async fn list_dir(root: String, rel: String) -> CmdResult<Vec<crate::files::DirEntry>> {
    tauri::async_runtime::spawn_blocking(move || crate::files::list_dir(Path::new(&root), &rel)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<crate::files::TextFile> {
    tauri::async_runtime::spawn_blocking(move || crate::files::read_text(Path::new(&path))).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> CmdResult<u64> {
    tauri::async_runtime::spawn_blocking(move || crate::files::write_text(Path::new(&path), &content)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub fn file_mtime(path: String) -> Option<u64> {
    crate::files::stat_mtime(Path::new(&path))
}

#[tauri::command]
pub async fn search_text(root: String, query: String, regex: bool, case_sensitive: bool, limit: Option<usize>) -> CmdResult<crate::files::TextSearch> {
    tauri::async_runtime::spawn_blocking(move || crate::files::search_text(Path::new(&root), &query, regex, case_sensitive, limit.unwrap_or(500)))
        .await
        .map_err(err)?
        .map_err(err)
}

// ------------------------------------------------------------------ dictation

#[tauri::command]
pub fn dictation_available() -> bool {
    crate::dictation::Dictation::available()
}

// Opening a microphone means talking to CoreAudio, which walks every audio
// device on the system and can block for a second or more. A synchronous
// command runs on the thread that services the webview's IPC — the main thread
// — so these hop onto the blocking pool and return as soon as the work is
// handed over.
#[tauri::command]
pub async fn dictation_start(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let (dictation, transcription) = (state.dictation.clone(), state.transcription.clone());
    tauri::async_runtime::spawn_blocking(move || dictation.start(app, transcription)).await.map_err(err)?
}

#[tauri::command]
pub async fn dictation_stop(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let (dictation, transcription) = (state.dictation.clone(), state.transcription.clone());
    tauri::async_runtime::spawn_blocking(move || dictation.stop(app, transcription)).await.map_err(err)?
}

// ------------------------------------------------------------------ transcription models

#[tauri::command]
pub fn transcription_models(state: State<'_, AppState>) -> Vec<crate::transcription::ModelRow> {
    state.transcription.models()
}

#[tauri::command]
pub fn transcription_download(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.transcription.downloads.start(app, &id).map_err(err)
}

#[tauri::command]
pub fn transcription_cancel_download(state: State<'_, AppState>, id: String) {
    state.transcription.downloads.cancel(&id);
}

#[tauri::command]
pub fn transcription_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.transcription.delete(&id).map_err(err)
}

#[tauri::command]
pub fn transcription_set_model(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.transcription.set_model(&id).map_err(err)
}

/// Enumerates input devices, so it must stay off the IPC thread.
#[tauri::command]
pub async fn transcription_settings(state: State<'_, AppState>) -> CmdResult<crate::transcription::TranscriptionSettings> {
    let transcription = state.transcription.clone();
    tauri::async_runtime::spawn_blocking(move || transcription.settings()).await.map_err(err)
}

#[tauri::command]
pub fn transcription_set_input(state: State<'_, AppState>, device: Option<String>) -> CmdResult<()> {
    state.transcription.set_input(device).map_err(err)
}

#[tauri::command]
pub fn transcription_set_mute(state: State<'_, AppState>, mute: bool) -> CmdResult<()> {
    state.transcription.set_mute(mute).map_err(err)
}

// ------------------------------------------------------------------ issues

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearStatus {
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer: Option<String>,
}

fn linear_key() -> CmdResult<String> {
    store::settings::load().linear_api_key.filter(|k| !k.trim().is_empty()).ok_or_else(|| "Linear is not connected. Add an API key in Settings → Integrations.".to_string())
}

#[tauri::command]
pub async fn issues_list(project_path: String, provider: String, filter: crate::issues::IssueFilter) -> CmdResult<Vec<crate::issues::Issue>> {
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "github" => crate::issues::github_list(Path::new(&project_path), &filter).map_err(err),
        "linear" => crate::issues::linear_list(&linear_key()?, &filter).map_err(err),
        other => Err(format!("unknown issue provider {other}")),
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn issue_details(project_path: String, provider: String, id: String) -> CmdResult<crate::issues::Issue> {
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "github" => crate::issues::github_details(Path::new(&project_path), &id).map_err(err),
        "linear" => crate::issues::linear_details(&linear_key()?, &id).map_err(err),
        other => Err(format!("unknown issue provider {other}")),
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn linear_status() -> LinearStatus {
    let s = store::settings::load();
    let connected = s.linear_api_key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false);
    LinearStatus { connected, viewer: if connected { s.linear_viewer } else { None } }
}

/// Store a key after checking it answers; an empty key disconnects.
#[tauri::command]
pub async fn linear_set_api_key(key: String) -> CmdResult<LinearStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = key.trim().to_string();
        let mut s = store::settings::load();
        if key.is_empty() {
            s.linear_api_key = None;
            s.linear_viewer = None;
            store::settings::save(&s).map_err(err)?;
            return Ok(LinearStatus { connected: false, viewer: None });
        }
        let viewer = crate::issues::linear_viewer(&key).map_err(err)?;
        s.linear_api_key = Some(key);
        s.linear_viewer = Some(viewer.clone());
        store::settings::save(&s).map_err(err)?;
        Ok(LinearStatus { connected: true, viewer: Some(viewer) })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn linear_teams() -> CmdResult<Vec<crate::issues::IssueTeam>> {
    tauri::async_runtime::spawn_blocking(move || crate::issues::linear_teams(&linear_key()?).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub fn github_repo(project_path: String) -> Option<String> {
    crate::issues::github_repo(Path::new(&project_path))
}

#[cfg(test)]
mod command_tests {
    use std::path::Path;
    use std::process::Command;

    use super::{create_session_entry, requested_worktree_name, validate_session_target, NewSession};

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git").current_dir(cwd).args(args).output().unwrap();
        assert!(output.status.success(), "git {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).into_owned()
    }
    #[test]
    fn requested_names_are_sanitised_and_unique() {
        assert_eq!(requested_worktree_name("ENG-42 Fix Login!", &[]).as_deref(), Some("eng-42-fix-login"));
        assert_eq!(requested_worktree_name("!!!", &[]), None);
        let taken = vec!["eng-42-fix-login".to_string(), "eng-42-fix-login-2".to_string()];
        assert_eq!(requested_worktree_name("eng-42-fix-login", &taken).as_deref(), Some("eng-42-fix-login-3"));
    }

    #[test]
    fn create_session_opens_an_existing_worktree_without_a_tab() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let external = dir.path().join("external");
        std::fs::create_dir(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        git(&project, &["config", "user.email", "t@example.com"]);
        git(&project, &["config", "user.name", "T"]);
        std::fs::write(project.join("README.md"), "project\n").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-q", "-m", "initial"]);
        git(&project, &["worktree", "add", "-q", "-b", "feature/external", external.to_str().unwrap()]);
        let before = git(&project, &["worktree", "list", "--porcelain"]);

        let session = create_session_entry(NewSession {
            project_path: project.to_string_lossy().into_owned(),
            title: None,
            use_worktree: true,
            on_main: false,
            base_ref: None,
            worktree_name: None,
            issue: None,
            automation: None,
            cwd: Some(external.to_string_lossy().into_owned()),
            tab: None,
        })
        .unwrap();

        assert_eq!(session.cwd, external.canonicalize().unwrap().to_string_lossy());
        assert_eq!(session.branch.as_deref(), Some("feature/external"));
        assert_eq!(session.title, "feature/external");
        assert!(session.tabs.is_empty());
        assert_eq!(session.active_tab, None);
        assert_eq!(session.worktree_name, None);
        assert_eq!(git(&project, &["worktree", "list", "--porcelain"]), before);
        assert_eq!(crate::store::index::load().unwrap(), vec![session]);
    }

    #[test]
    fn requested_worktree_cannot_be_silently_skipped() {
        let req: NewSession = serde_json::from_value(serde_json::json!({
            "projectPath": "/repo",
            "useWorktree": false,
            "worktreeName": "eng-42-fix-login",
            "tab": { "harness": "claude" }
        }))
        .unwrap();

        let error = validate_session_target(&req).unwrap_err();
        assert!(error.contains("onMain"));
    }
}

// ------------------------------------------------------------------ projects & workspaces

#[tauri::command]
pub fn update_project(path: String, patch: projects::ProjectPatch) -> CmdResult<Project> {
    projects::update(&path, patch).map_err(err)
}

/// Copy a chosen image into the store so the project keeps it even if the
/// original moves, and record it as the logo.
#[tauri::command]
pub fn set_project_logo(path: String, source: Option<String>) -> CmdResult<Project> {
    let logo = match source {
        Some(src) => {
            let dir = store::root().map_err(err)?.join("logos");
            std::fs::create_dir_all(&dir).map_err(err)?;
            let ext = Path::new(&src).extension().and_then(|e| e.to_str()).unwrap_or("png");
            let name = format!("{:x}.{ext}", md5_like(&path));
            let dest = dir.join(name);
            std::fs::copy(&src, &dest).map_err(err)?;
            Some(dest.to_string_lossy().into_owned())
        }
        None => None,
    };
    projects::update(&path, projects::ProjectPatch { logo: Some(logo), ..Default::default() }).map_err(err)
}

fn md5_like(s: &str) -> u64 {
    // A stable file name per project; not a security hash.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[tauri::command]
pub async fn list_workspaces(project_path: String) -> CmdResult<Vec<crate::workspaces::Workspace>> {
    tauri::async_runtime::spawn_blocking(move || crate::workspaces::list(Path::new(&project_path)).map_err(err)).await.map_err(err)?
}

#[tauri::command]
pub async fn workspace_disposition(project_path: String, path: String) -> CmdResult<crate::workspaces::WorkspaceDisposition> {
    tauri::async_runtime::spawn_blocking(move || crate::workspaces::disposition(Path::new(&project_path), Path::new(&path))).await.map_err(err)
}

/// Remove a worktree; sessions that lived there move to the project root
/// and keep their transcripts.
#[tauri::command]
pub async fn delete_workspace(app: AppHandle, project_path: String, path: String, delete_branch: bool) -> CmdResult<Vec<SessionEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let target = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
        let sessions = index::load().map_err(err)?;
        let affected: Vec<SessionEntry> = sessions.into_iter().filter(|s| std::fs::canonicalize(&s.cwd).map(|c| c == target).unwrap_or(s.cwd == path)).collect();
        for s in &affected {
            for t in &s.tabs {
                kill_tab(&state, &s.id, &t.id);
            }
        }
        crate::workspaces::delete(Path::new(&project_path), &target, delete_branch).map_err(err)?;
        let branch = git::current_branch(Path::new(&project_path));
        let mut moved = Vec::new();
        for s in &affected {
            let out = index::update_session(&s.id, |s| {
                s.cwd = s.project_path.clone();
                s.worktree_name = None;
                s.worktree_removed = true;
                s.branch = branch.clone();
                s.base_ref = None;
                for t in &mut s.tabs {
                    t.status = TabStatus::Idle;
                }
                Ok(s.clone())
            })
            .map_err(err)?;
            let _ = app.emit("session_updated", &out);
            moved.push(out);
        }
        Ok(moved)
    })
    .await
    .map_err(err)?
}
