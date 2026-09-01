mod binpath;
mod commands;
#[allow(dead_code)] // consumed once the harness mappers land
mod events;
mod git;
mod harness;
mod models;
mod names;
mod session;
mod store;

use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub host: Arc<harness::host::Host>,
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
    let state = AppState { host: host.clone(), manager: std::sync::Mutex::new(None) };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(state)
        .setup(move |app| {
            let manager = session::SessionManager::new(app.handle().clone(), host.clone());
            *app.state::<AppState>().manager.lock().unwrap() = Some(manager);
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
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.host.kill_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
