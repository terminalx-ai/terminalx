mod account;
mod automations;
mod binpath;
pub mod browser;
pub mod cli;
mod commands;
pub mod computer;
mod control;
mod dictation;
mod transcription;
mod events;
mod files;
mod media;
mod git;
mod github;
mod harness;
pub mod hooks;
mod issues;
mod installation;
mod models;
mod names;
mod pairing;
mod pty;
mod session;
mod continuation;
pub mod skills;
mod store;
mod status;
mod stats;
mod star_nag;
mod summaries;
mod workspaces;

use std::sync::Arc;
use tauri::{Listener, Manager};

const DEEP_LINK_SCHEMES: [&str; 2] = ["terminalx", "terminalx-next"];

fn supports_deep_link_scheme(scheme: &str) -> bool {
    DEEP_LINK_SCHEMES.contains(&scheme)
}

pub struct AppState {
    pub account: Arc<account::AccountManager>,
    pub pairing: Arc<pairing::PairingManager>,
    pub host: Arc<harness::host::Host>,
    pub terminals: Arc<pty::Terminals>,
    pub dictation: Arc<dictation::Dictation>,
    pub transcription: Arc<transcription::Transcription>,
    /// Which Codex models this account may run, read from the CLI once.
    pub codex_models: Arc<harness::codex::models::Cache>,
    pub status: Arc<status::StatusState>,
    pub star_nag: Arc<star_nag::StarNag>,
    pub stats_usage: Arc<stats::StatsUsageStore>,
    /// Desktop automation for agents; the helper it spawns dies with the app.
    pub computer: Arc<computer::ComputerService>,
    /// The built-in browser: agent-browser sessions, pages and profiles.
    pub browser: Arc<browser::BrowserRuntime>,
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
    let status_state = Arc::new(status::StatusState::default());
    let account = Arc::new(account::AccountManager::default());
    let pairing = Arc::new(pairing::PairingManager::new(account.clone()));
    // The resource directory is only known once Tauri is up; the service
    // resolves the helper lazily, so it can be built before `setup`.
    let computer = Arc::new(computer::ComputerService::new(None));
    let browser = Arc::new(browser::BrowserRuntime::open().expect("open the browser stores under RACCOON_HOME"));
    let state = AppState {
        account: account.clone(),
        pairing: pairing.clone(),
        host: host.clone(),
        terminals: terminals.clone(),
        dictation: Arc::new(dictation::Dictation::default()),
        transcription: Arc::new(transcription::Transcription::default()),
        codex_models: codex_models.clone(),
        status: status_state.clone(),
        star_nag: Arc::new(star_nag::StarNag::load(env!("CARGO_PKG_VERSION"))),
        stats_usage: Arc::new(stats::StatsUsageStore::default()),
        computer: computer.clone(),
        browser: browser.clone(),
        manager: std::sync::Mutex::new(None),
    };

    tauri::Builder::default()
        .manage(media::MediaServer::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(state)
        .setup(move |app| {
            account.configure(&app.config().identifier)?;
            pairing.configure(app.handle(), &app.config().identifier)?;
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                let account = account.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if supports_deep_link_scheme(url.scheme()) {
                            account::focus_main_window(&app_handle);
                            if account::is_launch_link(&url) {
                                log::info!("received TerminalX launch link");
                            } else if account.handle_deep_link(&app_handle, &url) {
                                log::info!("received TerminalX account callback");
                            } else {
                                log::warn!("ignored unrecognized TerminalX deep link");
                            }
                        } else {
                            log::warn!("ignored deep link with unsupported scheme");
                        }
                    }
                });
            }
            status::install_menu(app)?;
            if let Ok(resources) = app.path().resource_dir() {
                computer.set_resource_dir(resources);
            }
            // Recover local history before hooks/automations can publish live
            // activity. Provider cache scans are deliberately unrelated.
            if let Err(error) = store::activity::summary() {
                log::error!("initialize activity history: {error:#}");
            }
            let control_endpoint = hooks::prepare_control()?;
            let manager = session::SessionManager::new(
                app.handle().clone(),
                host.clone(),
                terminals.clone(),
                codex_models.clone(),
                status_state.clone(),
                control_endpoint.clone(),
            );
            *app.state::<AppState>().manager.lock().unwrap() = Some(manager.clone());
            // The agent CLIs' hooks reach the app through this socket; without
            // it a PTY-first tab still runs, it just cannot report or ask.
            let hooked = manager.clone();
            let service = control::ControlService::new(app.handle().clone(), manager.clone(), control_endpoint.clone(), computer.clone(), browser.clone());
            match hooks::serve(control_endpoint, move |frame| hooked.on_hook(frame), move |request| service.handle(request)) {
                Ok(path) => log::info!("hook socket at {}", path.display()),
                Err(e) => log::warn!("hook socket: {e:#}"),
            }
            std::thread::spawn(|| {
                if let Err(error) = github::recover_workspace_prs() {
                    log::warn!("recover workspace PR history: {error:#}");
                    store::activity::report_error(format!("Workspace PR recovery is incomplete; discovery will retry on restart or workspace refresh: {error:#}"));
                }
            });
            let exited = manager.clone();
            app.listen("pty_exit", move |event| {
                if let Ok(exit) = serde_json::from_str::<pty::PtyExit>(event.payload()) {
                    exited.pane_exited(&exit.id, exit.code);
                }
            });
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
            automations::start_scheduler(app.handle().clone());
            // The built-in browser: sweep daemons a crashed run left behind,
            // then keep this run's own daemons warm and its page list honest.
            browser.attach(app.handle().clone());
            browser.sweep_orphans();
            browser.start_keepalive();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::account_status,
            commands::account_sign_in,
            commands::account_sign_out,
            commands::pairing_status,
            commands::pairing_generate,
            commands::pairing_revoke,
            commands::pairing_set_host_name,
            commands::add_project,
            commands::remove_project,
            commands::select_project,
            commands::list_sessions,
            commands::automations_list,
            commands::automation_runs,
            commands::automation_issue_states,
            commands::automation_issue_preview,
            commands::automation_create,
            commands::automation_update,
            commands::automation_delete,
            commands::automation_run_now,
            commands::session_summaries,
            commands::stats_usage_snapshot,
            commands::app_activity_summary,
            commands::stats_usage_refresh,
            commands::create_session,
            commands::add_tab,
            commands::remove_tab,
            commands::rename_session,
            commands::set_session_archived,
            commands::set_session_pinned,
            commands::set_active_tab,
            commands::delete_session,
            commands::list_harnesses,
            commands::list_skills,
            commands::skill_detail,
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
            commands::prepare_continuation,
            commands::send_message,
            commands::interrupt_turn,
            commands::stop_tab,
            commands::tab_handoff,
            commands::ensure_tab_started,
            commands::tab_pane,
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
            commands::pr_details,
            commands::pr_create,
            commands::pr_merge,
            commands::pr_ready,
            commands::gh_available,
            star_nag::star_nag_ready,
            star_nag::star_nag_input,
            star_nag::star_nag_dismiss,
            star_nag::star_nag_act,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::mobile_terminal_drivers,
            commands::pty_kill,
            commands::list_dir,
            media::open_media_file,
            media::close_media_file,
            commands::read_text_file,
            commands::write_text_file,
            commands::file_mtime,
            commands::search_text,
            commands::replace_text,
            commands::settle_session,
            commands::fork_session,
            commands::dictation_available,
            commands::dictation_start,
            commands::dictation_stop,
            commands::update_project,
            commands::set_project_logo,
            commands::list_workspaces,
            commands::preview_workspace_name,
            commands::rename_workspace,
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
            commands::transcription_preferences,
            commands::transcription_inputs,
            commands::transcription_set_input,
            commands::transcription_set_mute,
            commands::status_bar_settings,
            commands::set_status_bar_settings,
            commands::status_usage_snapshot,
            commands::status_usage_refresh,
            commands::status_codex_reset,
            commands::status_resource_overview,
            commands::status_resource_sample,
            commands::status_resource_kill,
            browser::ui::browser_pages,
            browser::ui::browser_open_tab,
            browser::ui::browser_close_page,
            browser::ui::browser_activate_page,
            browser::ui::browser_navigate,
            browser::ui::browser_screencast,
            browser::ui::browser_runtime_status,
            browser::ui::browser_install_browser,
            browser::ui::browser_profiles,
            installation::cli_tool_status,
            installation::install_cli_tool,
            installation::cli_skill_status,
            installation::install_cli_skill,
            computer::computer_permission_status,
            computer::computer_open_permission,
            computer::computer_reset_permissions,
        ])
        .on_menu_event(|app, event| {
            if event.id().as_ref() == status::MENU_ID {
                status::toggle_from_menu(app);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.pairing.stop();
                    if window.label() == "main" {
                        if let Err(error) = store::activity::shutdown() {
                            log::error!("flush activity on window teardown: {error:#}");
                        }
                    }
                    state.host.kill_all();
                    state.terminals.kill_all();
                    state.computer.shutdown();
                    state.browser.shutdown();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app.state::<AppState>();
                state.stats_usage.shutdown();
                // Cmd+Q and `relaunch()` end the run loop without necessarily
                // destroying the window first; the computer-use helper must
                // not outlive the app on either path.
                state.computer.shutdown();
                if let Err(error) = store::activity::shutdown() {
                    log::error!("flush activity on exit: {error:#}");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::supports_deep_link_scheme;

    #[test]
    fn accepts_current_and_legacy_deep_link_schemes() {
        assert!(supports_deep_link_scheme("terminalx"));
        assert!(supports_deep_link_scheme("terminalx-next"));
        assert!(!supports_deep_link_scheme("https"));
    }
}
