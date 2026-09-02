mod binpath;
mod commands;
mod dictation;
mod transcription;
#[allow(dead_code)] // consumed once the harness mappers land
mod events;
mod files;
mod git;
mod github;
mod harness;
pub mod hooks;
mod issues;
mod models;
mod names;
mod pty;
mod session;
mod store;
mod summaries;
mod workspaces;

use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub host: Arc<harness::host::Host>,
    pub terminals: Arc<pty::Terminals>,
    pub dictation: Arc<dictation::Dictation>,
    pub transcription: Arc<transcription::Transcription>,
    /// Which Codex models this account may run, read from the CLI once.
    pub codex_models: Arc<harness::codex::models::Cache>,
    manager: std::sync::Mutex<Option<session::SessionManager>>,
}

impl AppState {
    pub fn manager(&self) -> Option<session::SessionManager> {
        self.manager.lock().unwrap().clone()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let host = Arc::new(harness::host::Host::new());
    let codex_models = Arc::new(harness::codex::models::Cache::default());
    let terminals = Arc::new(pty::Terminals::new());
    let state = AppState {
        host: host.clone(),
        terminals: terminals.clone(),
        dictation: Arc::new(dictation::Dictation::default()),
        transcription: Arc::new(transcription::Transcription::default()),
        codex_models: codex_models.clone(),
        manager: std::sync::Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(state)
        .setup(move |app| {
            let manager = session::SessionManager::new(app.handle().clone(), host.clone(), terminals.clone(), codex_models.clone());
            *app.state::<AppState>().manager.lock().unwrap() = Some(manager.clone());
            // The agent CLIs' hooks reach the app through this socket; without
            // it a PTY-first tab still runs, it just cannot report or ask.
            let hooked = manager.clone();
            match hooks::serve(move |frame| hooked.on_hook(frame)) {
                Ok(path) => log::info!("hook socket at {}", path.display()),
                Err(e) => log::warn!("hook socket: {e:#}"),
            }
            // No child survives a restart: a tab persisted mid-turn or waiting
            // is idle now, whatever the index says.
            let _ = store::index::update(|sessions| {
                for s in sessions.iter_mut() {
                    for t in s.tabs.iter_mut() {
                        if matches!(t.status, store::index::TabStatus::InProgress | store::index::TabStatus::Waiting) {
                            t.status = store::index::TabStatus::Idle;
                        }
                    }
                }
                Ok(())
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::select_project,
            commands::list_sessions,
            commands::session_summaries,
            commands::create_session,
            commands::add_tab,
            commands::remove_tab,
            commands::rename_session,
            commands::set_session_archived,
            commands::set_session_pinned,
            commands::set_active_tab,
            commands::delete_session,
            commands::list_harnesses,
            commands::work_status,
            commands::list_branches,
            commands::worktree_disposition,
            commands::remove_session_worktree,
            commands::snapshot_tree,
            commands::head_tree,
            commands::changes_between,
            commands::file_contents_at,
            commands::log_commits,
            commands::load_tab_events,
            commands::send_message,
            commands::interrupt_turn,
            commands::stop_tab,
            commands::tab_handoff,
            commands::ensure_tab_started,
            commands::cancel_queued,
            commands::list_queued,
            commands::respond_permission,
            commands::answer_questions,
            commands::set_tab_model,
            commands::set_tab_permission_mode,
            commands::set_tab_effort,
            commands::mark_tab_read,
            commands::tab_status,
            commands::list_models,
            commands::frontend_log,
            commands::search_files,
            commands::list_slash_commands,
            commands::read_image_file,
            commands::invalidate_file_index,
            commands::git_commit,
            commands::git_push,
            commands::git_pull,
            commands::git_discard,
            commands::git_checkout,
            commands::working_changes,
            commands::pr_list,
            commands::pr_create,
            commands::pr_merge,
            commands::pr_ready,
            commands::gh_available,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_is_live,
            commands::list_dir,
            commands::read_text_file,
            commands::write_text_file,
            commands::file_mtime,
            commands::search_text,
            commands::settle_session,
            commands::fork_session,
            commands::dictation_available,
            commands::dictation_start,
            commands::dictation_stop,
            commands::update_project,
            commands::set_project_logo,
            commands::list_workspaces,
            commands::workspace_disposition,
            commands::delete_workspace,
            commands::issues_list,
            commands::issue_details,
            commands::linear_status,
            commands::linear_set_api_key,
            commands::linear_teams,
            commands::github_repo,
            commands::transcription_models,
            commands::transcription_download,
            commands::transcription_cancel_download,
            commands::transcription_delete,
            commands::transcription_set_model,
            commands::transcription_settings,
            commands::transcription_set_input,
            commands::transcription_set_mute,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.host.kill_all();
                    state.terminals.kill_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
