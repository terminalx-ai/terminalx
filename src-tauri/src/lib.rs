// The desktop app is the default build. Without the `desktop` feature the
// crate is the headless runtime behind `terminalx-serve`: no Tauri, WebView,
// GTK or audio, and none of the modules that only exist to serve a window.
// Much of the shared code is reached only from Tauri commands, hence the
// allowances there.
#![cfg_attr(not(feature = "desktop"), allow(dead_code, unused_imports))]

#[cfg(feature = "desktop")]
mod account;
#[cfg(feature = "desktop")]
mod automations;
mod binpath;
mod cloud_activity;
mod cloud_bootstrap;
mod cloud_quiesce;
pub mod cloud_agents;
mod cloud_github;
mod cloud_config;
mod cloud_grants;
#[cfg(feature = "desktop")]
pub mod browser;
#[cfg(feature = "desktop")]
pub mod cli;
#[cfg(feature = "desktop")]
mod commands;
#[cfg(feature = "desktop")]
mod cloud_agent_client;
#[cfg(feature = "desktop")]
mod cloud_remote;
#[cfg(feature = "desktop")]
mod cloud_workspaces;
#[cfg(feature = "desktop")]
mod organization_github_app;
#[cfg(feature = "desktop")]
mod organization_members;
#[cfg(feature = "desktop")]
mod organization_compute;
#[cfg(feature = "desktop")]
mod organization_workspace_config;
#[cfg(feature = "desktop")]
pub mod computer;
mod control;
#[cfg(windows)]
mod pipe_transport;
#[cfg(feature = "desktop")]
mod dictation;
#[cfg(feature = "desktop")]
mod transcription;
mod events;
mod files;
#[cfg(feature = "desktop")]
mod media;
mod media_types;
mod git;
mod github;
mod harness;
pub mod hooks;
mod issues;
#[cfg(feature = "desktop")]
mod installation;
mod memory_baseline;
mod models;
mod names;
#[cfg(feature = "desktop")]
mod pairing;
mod pty;
mod relay_e2ee;
pub mod remote;
mod session;
mod session_ops;
pub mod serve;
mod sink;
mod recovery;
mod continuation;
pub mod skills;
mod store;
mod status;
mod stats;
#[cfg(feature = "desktop")]
mod star_nag;
mod summaries;
mod workspaces;

#[cfg(feature = "desktop")]
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::Manager;

#[cfg(feature = "desktop")]
const DEEP_LINK_SCHEMES: [&str; 2] = ["terminalx", "terminalx-next"];

#[cfg(feature = "desktop")]
fn supports_deep_link_scheme(scheme: &str) -> bool {
    DEEP_LINK_SCHEMES.contains(&scheme)
}

#[cfg(feature = "desktop")]
pub struct AppState {
    pub account: Arc<account::AccountManager>,
    pub cloud_workspaces: Arc<cloud_workspaces::CloudWorkspaceService>,
    pub organization_members: Arc<organization_members::OrganizationMembersService>,
    pub organization_compute: Arc<organization_compute::OrganizationComputeService>,
    pub organization_github_app: Arc<organization_github_app::OrganizationGithubAppService>,
    pub workspace_config: Arc<organization_workspace_config::WorkspaceConfigService>,
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

#[cfg(feature = "desktop")]
impl AppState {
    pub fn manager(&self) -> Option<session::SessionManager> {
        self.manager.lock().unwrap().clone()
    }
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let host = Arc::new(harness::host::Host::new());
    let codex_models = Arc::new(harness::codex::models::Cache::default());
    let terminals = Arc::new(pty::Terminals::new());
    let status_state = Arc::new(status::StatusState::default());
    let account = Arc::new(account::AccountManager::default());
    let pairing = Arc::new(pairing::PairingManager::new(account.clone()));
    let cloud_workspaces = Arc::new(cloud_workspaces::CloudWorkspaceService::new(account.clone()));
    let organization_members = Arc::new(organization_members::OrganizationMembersService::new(account.clone()));
    let agent_keys = Arc::new(cloud_agent_client::KeychainKeys::default());
    let cloud_agents = Arc::new(
        cloud_agent_client::CloudAgentClient::new(account.clone(), agent_keys.clone()).expect("open the cloud agent store under TERMINALX_HOME"),
    );
    let organization_compute = Arc::new(organization_compute::OrganizationComputeService::new(account.clone()));
    let organization_github_app = Arc::new(organization_github_app::OrganizationGithubAppService::new(account.clone()));
    let workspace_config = Arc::new(organization_workspace_config::WorkspaceConfigService::new(account.clone()));
    let cloud_remote = cloud_remote::CloudRemote::new(account.clone(), cloud_workspaces.clone(), cloud_agents.clone());
    // The resource directory is only known once Tauri is up; the service
    // resolves the helper lazily, so it can be built before `setup`.
    let computer = Arc::new(computer::ComputerService::new(None));
    let browser = Arc::new(browser::BrowserRuntime::open().expect("open the browser stores under TERMINALX_HOME"));
    let state = AppState {
        account: account.clone(),
        cloud_workspaces,
        organization_members,
        organization_compute,
        organization_github_app,
        workspace_config,
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
        .manage(cloud_remote.clone())
        .manage(cloud_agents)
        .setup(move |app| {
            agent_keys.configure(&app.config().identifier);
            cloud_remote.watch_identity(app.handle().clone());
            account.configure(&app.config().identifier)?;
            pairing.configure(Arc::new(app.handle().clone()), app.path().app_log_dir().ok(), &app.config().identifier)?;
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
            let sink: Arc<dyn sink::EventSink> = Arc::new(app.handle().clone());
            let manager = session::SessionManager::new(
                sink.clone(),
                Arc::new(app.handle().clone()),
                host.clone(),
                terminals.clone(),
                codex_models.clone(),
                status_state.clone(),
                control_endpoint.clone(),
            );
            *app.state::<AppState>().manager.lock().unwrap() = Some(manager.clone());
            pairing.attach_sessions(manager.clone());
            // The agent CLIs' hooks reach the app through this socket; without
            // it a PTY-first tab still runs, it just cannot report or ask.
            let hooked = manager.clone();
            let service = control::ControlService::new(sink.clone(), manager.clone(), control_endpoint.clone(), computer.clone(), browser.clone());
            match hooks::serve(control_endpoint, move |frame| hooked.on_hook(frame), move |request| service.handle(request)) {
                Ok(path) => log::info!("hook socket at {}", path.display()),
                Err(e) => log::warn!("hook socket: {e:#}"),
            }
            std::thread::spawn(|| {
                if let Err(error) = github::recover_workspace_prs() {
                    let detail = format!("{error:#}").to_lowercase();
                    let category = if detail.contains("auth") || detail.contains("login") || detail.contains("credential") {
                        "credentials"
                    } else if detail.contains("rate limit") {
                        "rate_limit"
                    } else {
                        "connection"
                    };
                    log::warn!("recover workspace PR history failed (category={category}; workspace details omitted)");
                    let message = if category == "credentials" {
                        "GitHub credentials need attention before pull-request data can be refreshed."
                    } else if category == "rate_limit" {
                        "GitHub rate limits prevented pull-request data from refreshing. We’ll retry on restart or workspace refresh."
                    } else {
                        "Some pull-request data couldn’t be refreshed because GitHub is unreachable. We’ll retry on restart or workspace refresh."
                    };
                    store::activity::report_error(message.into());
                }
            });
            manager.follow_pane_exits();
            session::idle_orphaned_tabs();
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
            commands::organization_create,
            commands::organization_select,
            commands::organization_members,
            commands::organization_member_invite,
            commands::organization_invite_revoke,
            commands::organization_member_role_update,
            commands::organization_member_remove,
            commands::organization_compute_policy,
            commands::organization_compute_usage,
            commands::organization_compute_policy_update,
            commands::organization_compute_provisioning_pause,
            commands::organization_github_app,
            commands::organization_github_app_connect,
            commands::organization_github_app_attempt,
            commands::organization_github_app_attempt_cancel,
            commands::organization_github_app_repositories,
            commands::organization_github_app_repositories_save,
            commands::organization_github_app_disconnect,
            commands::organization_github_app_open,
            commands::workspace_config_organization,
            commands::workspace_config_organization_update,
            commands::workspace_config_repository_update,
            commands::workspace_config_workspace,
            commands::workspace_config_workspace_update,
            commands::workspace_config_secrets,
            commands::workspace_config_secret_put,
            commands::workspace_config_secret_delete,
            commands::workspace_config_secret_bind,
            commands::workspace_config_secret_unbind,
            commands::cloud_providers,
            commands::cloud_provider,
            commands::cloud_provider_connect,
            commands::cloud_provider_disconnect,
            commands::cloud_workspace_setup,
            commands::cloud_workspace_quote,
            commands::cloud_workspace_create,
            commands::cloud_workspace_preflight,
            commands::cloud_workspace_repositories,
            commands::cloud_workspaces,
            commands::cloud_workspace_suspend,
            commands::cloud_workspace_resume,
            commands::cloud_workspace_release,
            commands::cloud_workspace_archive,
            commands::cloud_workspace_delete,
            commands::cloud_workspace_unarchive,
            commands::cloud_workspace_disposition,
            commands::cloud_workspace_operation,
            commands::cloud_workspace_operation_cancel,
            cloud_remote::cloud_remote_attach,
            cloud_remote::cloud_remote_attach_dev,
            cloud_remote::cloud_remote_send,
            cloud_remote::cloud_remote_activate,
            cloud_remote::cloud_remote_detach,
            cloud_agent_client::cloud_agent_enqueue,
            cloud_agent_client::cloud_agent_outbox,
            cloud_agent_client::cloud_agent_outbox_sync,
            cloud_agent_client::cloud_agent_cancel,
            cloud_agent_client::cloud_agent_checkpoints,
            cloud_agent_client::cloud_agent_checkpoint,
            cloud_agent_client::cloud_agent_has_key,
            cloud_agent_client::cloud_agent_cache_load,
            cloud_agent_client::cloud_agent_cache_save,
            cloud_agent_client::cloud_agent_purge_workspace,
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
            commands::git_identity,
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
            commands::inspect_local_path,
            commands::open_local_path,
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

#[cfg(all(test, feature = "desktop"))]
mod tests {
    use super::supports_deep_link_scheme;

    #[test]
    fn accepts_current_and_legacy_deep_link_schemes() {
        assert!(supports_deep_link_scheme("terminalx"));
        assert!(supports_deep_link_scheme("terminalx-next"));
        assert!(!supports_deep_link_scheme("https"));
    }
}
