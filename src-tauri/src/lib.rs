// The desktop app is the default build. Without the `desktop` feature the
// crate is the headless runtime behind `terminalx-serve`: no Tauri, WebView,
// GTK or audio, and none of the modules that only exist to serve a window.
// Much of the shared code is reached only from Tauri commands, hence the
// allowances there.
#![cfg_attr(not(feature = "desktop"), allow(dead_code, unused_imports))]

#[cfg(feature = "desktop")]
mod account;
mod agent_data;
mod project_overview;
#[cfg(feature = "desktop")]
mod desktop_links;
mod automations;
mod binpath;
mod chat_link;
mod cleanup;
#[cfg(feature = "desktop")]
mod cloud_catalog;
mod cloud_activity;
#[cfg(feature = "desktop")]
mod cloud_mirror;
mod mirror_rules;
mod cloud_bootstrap;
mod cloud_quiesce;
mod cloud_resources;
mod cloud_environment;
pub mod cloud_agents;
mod cloud_github;
mod agent_route_check;
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
mod cloud_diagnostics;
#[cfg(feature = "desktop")]
mod cloud_ports;
#[cfg(feature = "desktop")]
mod cloud_remote;
#[cfg(feature = "desktop")]
mod agent_local_login;
#[cfg(feature = "desktop")]
mod codex_device_login;
#[cfg(feature = "desktop")]
mod cloud_workspaces;
#[cfg(feature = "desktop")]
mod organization_github_app;
#[cfg(feature = "desktop")]
mod organization_members;
#[cfg(feature = "desktop")]
mod organization_compute;
#[cfg(feature = "desktop")]
mod organization_environment;
#[cfg(feature = "desktop")]
mod organization_workspace_config;
#[cfg(feature = "desktop")]
pub mod computer;
mod control;
mod cloud_control;
#[cfg(windows)]
mod pipe_transport;
#[cfg(feature = "desktop")]
mod dictation;
#[cfg(feature = "desktop")]
mod drag_text;
#[cfg(feature = "desktop")]
mod transcription;
mod events;
mod files;
mod foreground;
#[cfg(feature = "desktop")]
mod floating;
#[cfg(feature = "desktop")]
mod media;
mod media_types;
mod git;
mod github;
mod pr_associations;
mod github_identity;
mod harness;
pub mod hooks;
#[cfg(feature = "desktop")]
mod issue_control;
mod issue_pipeline;
mod issue_ops;
mod issues;
#[cfg(feature = "desktop")]
mod installation;
#[cfg(feature = "desktop")]
mod keychain;
mod landed;
mod local_sharing;
pub mod local_runtime;
mod memory_baseline;
mod merged_cleanup;
mod models;
mod names;
#[cfg(feature = "desktop")]
mod pairing;
mod project_start;
mod pty;
#[cfg(feature = "desktop")]
mod quit;
mod relay_e2ee;
pub mod remote;
mod session;
mod session_ops;
pub mod serve;
pub mod sink;
mod recovery;
mod continuation;
pub mod skills;
mod store;
mod status;
mod stats;
#[cfg(feature = "desktop")]
mod star_nag;
mod summaries;
mod terminal_perf;
#[cfg(feature = "desktop")]
mod work_claims;
mod workspaces;
mod worktree_cleanup;

#[cfg(feature = "desktop")]
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::Manager;

#[cfg(feature = "desktop")]
pub struct AppState {
    pub account: Arc<account::AccountManager>,
    pub cloud_workspaces: Arc<cloud_workspaces::CloudWorkspaceService>,
    pub organization_members: Arc<organization_members::OrganizationMembersService>,
    pub organization_compute: Arc<organization_compute::OrganizationComputeService>,
    pub organization_github_app: Arc<organization_github_app::OrganizationGithubAppService>,
    pub workspace_config: Arc<organization_workspace_config::WorkspaceConfigService>,
    pub organization_environment: Arc<organization_environment::OrganizationEnvironmentService>,
    pub pairing: Arc<pairing::PairingManager>,
    /// Who works on which issue, across machines and teammates (#441).
    pub work_claims: Arc<work_claims::WorkClaims>,
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
    runtime: std::sync::Mutex<Option<Arc<local_runtime::desktop::Desktop>>>,
    runtime_error: std::sync::Mutex<String>,
    window_endpoint: std::sync::OnceLock<hooks::ControlEndpoint>,
}

#[cfg(feature = "desktop")]
impl AppState {
    pub fn manager(&self) -> Option<session::SessionManager> {
        self.manager.lock().unwrap().clone()
    }

    pub fn runtime(&self) -> Option<Arc<local_runtime::desktop::Desktop>> {
        self.runtime.lock().unwrap().clone()
    }

    pub fn sessions(&self) -> anyhow::Result<local_runtime::sessions::Sessions> {
        if let Some(runtime) = self.runtime() { return runtime.sessions(); }
        Err(anyhow::anyhow!(self.runtime_error.lock().unwrap().clone()))
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
    let paired = pairing.clone();
    let work_claims = Arc::new(work_claims::WorkClaims::new(account.clone(), move || paired.host_id()));
    let organization_members = Arc::new(organization_members::OrganizationMembersService::new(account.clone()));
    let agent_keys = Arc::new(cloud_agent_client::KeychainKeys::default());
    let cloud_agents = Arc::new(
        cloud_agent_client::CloudAgentClient::new(account.clone(), Arc::new(cloud_agent_client::CachedKeys::new(agent_keys.clone()))).expect("open the cloud agent store under TERMINALX_HOME"),
    );
    let organization_compute = Arc::new(organization_compute::OrganizationComputeService::new(account.clone()));
    let organization_github_app = Arc::new(organization_github_app::OrganizationGithubAppService::new(account.clone()));
    let workspace_config = Arc::new(organization_workspace_config::WorkspaceConfigService::new(account.clone()));
    let organization_environment = Arc::new(organization_environment::OrganizationEnvironmentService::new(account.clone()));
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
        organization_environment,
        pairing: pairing.clone(),
        work_claims: work_claims.clone(),
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
        runtime: std::sync::Mutex::new(None),
        runtime_error: std::sync::Mutex::new("The background runtime is not attached.".into()),
        window_endpoint: std::sync::OnceLock::new(),
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // On the press only: the release of the same keys is not a second toggle.
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed && floating::is_toggle_shortcut(app, shortcut) {
                        floating::later(app, "toggle", floating::toggle);
                    }
                })
                .build(),
        )
        .manage(floating::Floating::default())
        .manage(state)
        .manage(cloud_remote.clone())
        .manage(cloud_agents)
        .setup(move |app| {
            // A Codex sign-in home left by an app that crashed or was force-quit (PRO-79).
            #[cfg(feature = "desktop")]
            std::thread::spawn(|| codex_device_login::sweep_stale(&codex_device_login::homes_parent()));
            // Attachments are shown from the data folder, wherever
            // TERMINALX_HOME put it; the scope in tauri.conf.json only names
            // the default one.
            match store::root() {
                Ok(root) => {
                    if let Err(error) = app.asset_protocol_scope().allow_directory(root.join("attachments"), true) {
                        log::warn!("allow attachments in the asset scope: {error:#}");
                    }
                }
                Err(error) => log::warn!("allow attachments in the asset scope: {error:#}"),
            }
            agent_keys.configure(&app.config().identifier);
            cloud_remote.watch_identity(app.handle().clone());
            account.configure(&app.config().identifier)?;
            account.attach_app(app.handle());
            pairing.configure(Arc::new(app.handle().clone()), app.path().app_log_dir().ok(), &app.config().identifier)?;
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                let links = desktop_links::DesktopLinks::for_identifier(&app.config().identifier);
                let account = account.clone();
                let joining = pairing.clone();
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        if links.is_join_link(&url) { let _ = joining.set_pending_join(url.to_string()); }
                    }
                }
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if links.accepts_scheme(url.scheme()) {
                            account::focus_main_window(&app_handle);
                            if links.is_join_link(&url) {
                                if joining.set_pending_join(url.to_string()).is_err() { log::warn!("ignored invalid session link"); }
                            } else if links.is_launch_link(&url) {
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
                computer.set_resource_dir(resources, &app.config().identifier);
            }
            local_runtime::ui::observe(app.handle());
            let sink: Arc<dyn sink::EventSink> = Arc::new(app.handle().clone());
            let endpoint = hooks::prepare_control()?;
            let asking = app.handle().clone();
            let ask: issue_control::Ask = Arc::new(move |question: issue_control::Question| {
                tauri::async_runtime::block_on(commands::cloud_control_question(asking.clone(), question.title, question.message, question.agree))
            });
            control::WindowControl::new(sink, computer.clone(), browser.clone())
                .serve(app.handle().clone(), endpoint.clone(), pairing.clone(), ask)?;
            let _ = app.state::<AppState>().window_endpoint.set(endpoint);
            // Install window services before publishing their attachment. The
            // owner's Quick Chat action can arrive as soon as registration
            // succeeds; publishing first would silently lose that event.
            browser.attach(app.handle().clone());
            browser.sweep_orphans();
            browser.start_keepalive();
            floating::install(app.handle());
            if let Err(error) = local_runtime::ui::connect(app.handle()) {
                *app.state::<AppState>().runtime_error.lock().unwrap() = format!("{error:#}");
                log::error!("attach background runtime: {error:#}");
            }
            work_claims.start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_runtime::ui::local_runtime_status,
            local_runtime::ui::local_runtime_reconnect,
            local_runtime::ui::local_runtime_settings,
            local_runtime::ui::set_local_runtime_quit_behavior,
            commands::list_projects,
            commands::account_status,
            commands::account_refresh_roles,
            commands::account_sign_in,
            commands::organization_console_open,
            commands::account_sign_out,
            commands::organization_create,
            commands::organization_select,
            commands::organization_members,
            commands::organization_members_in,
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
            commands::organization_environment_status,
            commands::organization_environment_update,
            commands::organization_environment_build,
            commands::organization_environment_version,
            commands::organization_environment_version_retry,
            commands::organization_environment_version_cancel,
            commands::organization_environment_version_rollback,
            commands::organization_environment_recipes,
            commands::organization_environment_recipe_propose,
            commands::organization_environment_recipe_apply,
            commands::organization_environment_recipe_dismiss,
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
            commands::cloud_teardown_status,
            commands::cloud_teardown_preview,
            commands::cloud_teardown_request,
            commands::cloud_provider_set_creation_enabled,
            commands::cloud_provider_revalidate,
            commands::cloud_agent_logins,
            commands::cloud_agent_login_connect,
            commands::cloud_agent_login_remove,
            commands::cloud_agent_routes,
            commands::cloud_agent_route_save,
            commands::cloud_agent_route_remove,
            commands::cloud_agent_claude_login_start,
            commands::cloud_agent_claude_login_open,
            commands::cloud_agent_claude_login_complete,
            commands::cloud_agent_claude_login_cancel,
            commands::cloud_agent_codex_login_start,
            commands::cloud_agent_codex_login_open,
            commands::cloud_agent_codex_login_status,
            commands::cloud_agent_codex_login_cancel,
            commands::cloud_workspace_setup,
            commands::cloud_workspace_quote,
            commands::cloud_workspace_create,
            commands::cloud_workspace_preflight,
            commands::cloud_workspace_repositories,
            commands::cloud_workspaces,
            commands::cloud_catalog_feed,
            commands::cloud_workspace_suspend,
            commands::cloud_workspace_resume,
            commands::cloud_workspace_release,
            commands::cloud_workspace_archive,
            commands::cloud_workspace_delete,
            commands::cloud_workspace_unarchive,
            commands::cloud_workspace_disposition,
            commands::cloud_workspace_shares,
            commands::cloud_workspace_share_put,
            commands::cloud_workspace_share_revoke,
            commands::cloud_schedules,
            commands::cloud_schedule,
            commands::cloud_schedule_estimate,
            commands::cloud_schedule_create,
            commands::cloud_schedule_set_active,
            commands::cloud_schedule_delete,
            commands::cloud_schedules_pause_all,
            commands::cloud_workspace_set_access,
            commands::cloud_workspace_operation,
            commands::cloud_workspace_operation_cancel,
            cloud_remote::cloud_remote_attach,
            cloud_remote::cloud_remote_attach_dev,
            cloud_remote::cloud_remote_send,
            cloud_remote::cloud_remote_activate,
            cloud_remote::cloud_remote_detach,
            cloud_remote::cloud_port_forward,
            cloud_remote::cloud_port_unforward,
            cloud_remote::cloud_port_forwards,
            cloud_diagnostics::commands::cloud_diagnostics,
            cloud_diagnostics::commands::cloud_connection_diagnostics,
            cloud_diagnostics::commands::cloud_diagnostics_export,
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
            cloud_catalog::cloud_catalog_load,
            cloud_catalog::cloud_catalog_save,
            commands::pairing_status,
            commands::session_share_create,
            commands::session_share_status,
            commands::session_share_change,
            commands::session_join_pending,
            commands::session_guest_join,
            commands::session_guest_send,
            commands::session_guest_leave,
            commands::pairing_generate,
            commands::pairing_revoke,
            commands::pairing_set_host_name,
            commands::add_project,
            commands::chats_dir,
            commands::remove_project,
            commands::select_project,
            commands::github_repositories,
            commands::project_clone,
            commands::project_clone_cancel,
            commands::project_start_defaults,
            commands::project_create,
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
            commands::create_quick_chat,
            commands::set_quick_chat_cwd,
            commands::move_quick_chat_to_project,
            commands::quick_chat_scratch,
            floating::floating_status,
            floating::set_floating_settings,
            floating::floating_show,
            floating::floating_hide,
            floating::floating_visible,
            floating::floating_take_pending,
            floating::floating_open_in_main,
            commands::add_tab,
            commands::remove_tab,
            commands::reopen_tab,
            commands::rename_tab,
            commands::tab_state,
            commands::set_tab_layout,
            commands::tab_resume_conversation,
            commands::pane_agents,
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
            commands::sessions_sharing_worktree,
            commands::relocate_session,
            commands::sole_workspace_of,
            commands::snapshot_tree,
            commands::head_tree,
            commands::changes_between,
            commands::review_range,
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
            commands::send_queued_now,
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
            drag_text::dropped_text,
            commands::invalidate_file_index,
            commands::git_commit,
            commands::git_identity,
            commands::cloud_mirror_status,
            commands::cloud_mirror_enable,
            commands::cloud_mirror_disable,
            commands::cloud_mirror_check,
            commands::cloud_mirror_plan,
            commands::cloud_mirror_stage,
            commands::cloud_mirror_publish,
            commands::cloud_mirror_resolve,
            commands::cloud_mirror_list,
            commands::cloud_mirror_purge,
            commands::cloud_mirror_claim_owner,
            commands::cloud_mirror_note_unreadable,
            commands::git_push,
            commands::git_pull,
            commands::git_discard,
            commands::git_checkout,
            commands::working_changes,
            commands::pr_list,
            commands::pr_associations,
            commands::pr_details,
            commands::pr_landed,
            commands::pr_create,
            commands::pr_merge,
            commands::pr_ready,
            commands::gh_available,
            star_nag::star_nag_ready,
            star_nag::star_nag_input,
            star_nag::star_nag_dismiss,
            star_nag::star_nag_act,
            commands::pty_spawn,
            commands::pty_shells,
            commands::pty_rename,
            commands::pty_busy,
            commands::pty_write,
            commands::pty_attach,
            commands::pty_detach,
            commands::pty_detach_all,
            commands::pty_ack,
            commands::pty_resize,
            commands::mobile_terminal_drivers,
            commands::pty_kill,
            commands::terminal_perf_reply,
            commands::cloud_control_reply,
            commands::cloud_control_setting,
            commands::cloud_control_set_setting,
            commands::cloud_control_confirm,
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
            commands::fork_session,
            commands::dictation_available,
            commands::dictation_start,
            commands::dictation_stop,
            commands::update_project,
            commands::set_project_logo,
            commands::list_workspaces,
            commands::preview_workspace_name,
            commands::rename_workspace,
            commands::adopt_agent_title,
            commands::project_overview,
            commands::copy_text,
            commands::workspace_disposition,
            commands::remove_workspace,
            commands::workspace_size,
            commands::scan_leftovers,
            commands::remove_leftovers,
            commands::worktree_cleanup_scan,
            commands::worktree_cleanup_size,
            commands::worktree_cleanup_cancel_sizes,
            commands::worktree_cleanup_remove,
            commands::worktree_cleanup_stop,
            commands::merged_cleanup_settings,
            commands::set_merged_cleanup_settings,
            commands::work_claims_list,
            commands::work_claims_set_cloud,
            commands::work_status_settings,
            commands::set_work_status_settings,
            commands::organization_work_status,
            commands::set_organization_work_status,
            commands::session_link_issue,
            commands::session_unlink_issue,
            commands::session_set_work_private,
            commands::merged_cleanup_sweep,
            commands::merged_cleanup_hold,
            commands::merged_cleanup_records,
            commands::merged_cleanup_restore,
            commands::github_head_branch_setting,
            commands::github_enable_head_branch_deletion,
            quit::set_quit_warning,
            commands::issues_list,
            commands::issue_pipelines_list,
            commands::issue_pipeline_start,
            commands::issue_pipeline_continue,
            commands::issue_pipeline_set_auto_merge,
            commands::issue_pipeline_set_resolve_conflicts,
            commands::issue_pipeline_act,
            commands::issue_pipeline_merge_cloud,
            commands::issue_pipeline_linear_to_review,
            commands::issue_details,
            commands::issue_comments,
            commands::issue_options,
            commands::issue_viewer,
            commands::issue_comment_add,
            commands::issue_comment_edit,
            commands::issue_comment_delete,
            commands::issue_set_state,
            commands::issue_set_assignees,
            commands::issue_set_labels,
            commands::issue_set_priority,
            commands::issue_set_title,
            commands::issue_set_description,
            commands::issue_create,
            commands::issue_templates,
            commands::linear_status,
            commands::linear_set_api_key,
            commands::linear_teams,
            commands::github_repo,
            commands::github_identity,
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
            // The same request as the tray's Quit: it can be held back, see below.
            if event.id().as_ref() == quit::MENU_ID {
                app.exit(0);
            } else if event.id().as_ref() == quit::STOP_ALL_MENU_ID {
                quit::stop_all_and_quit(app);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drag) = event {
                drag_text::on_drag_drop(drag);
            }
            // The floating window is a view, not the app: closing it puts it
            // away, and what it showed carries on.
            if window.label() == floating::LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    floating::hide(window.app_handle());
                }
                return;
            }
            // The app goes with its main window, so closing it is a quit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && quit::held(window.app_handle()) {
                    api.prevent_close();
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Some(runtime) = state.runtime() { runtime.detach_window(window.label()); }
                    if window.label() == "main" {
                        state.pairing.stop();
                        if let Some(runtime) = state.runtime() { runtime.disconnect(); }
                        if let Some(floating) = window.app_handle().get_webview_window(floating::LABEL) { let _ = floating.destroy(); }
                        state.computer.shutdown();
                        state.browser.shutdown();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // A restart never returns to be told no, so it is not held back.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if *code != Some(tauri::RESTART_EXIT_CODE) && quit::held(app) {
                    api.prevent_exit();
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                // A Codex sign-in still open: its CLI is killed and its home wiped before the app goes.
                #[cfg(feature = "desktop")]
                commands::shutdown_codex_sign_in();
                let state = app.state::<AppState>();
                state.stats_usage.shutdown();
                // Cmd+Q/relaunch need not destroy a window first. Close the
                // agent PTYs here too so their MCP pipes receive EOF, just as
                // they do when an individual session is stopped (PRO-116).
                if let Some(manager) = state.manager() {
                    manager.closing();
                }
                state.host.kill_all();
                state.terminals.kill_all();
                // Cmd+Q and `relaunch()` end the run loop without necessarily
                // destroying the window first; the computer-use helper must
                // not outlive the app on either path.
                state.computer.shutdown();
                state.pairing.stop();
                if let Some(runtime) = state.runtime() { runtime.disconnect(); }
                state.browser.shutdown();
            }
        });
}
