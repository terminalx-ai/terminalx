// The desktop app is the default build. Without the `desktop` feature the
// crate is the headless runtime behind `terminalx-serve`: no Tauri, WebView,
// GTK or audio, and none of the modules that only exist to serve a window.
// Much of the shared code is reached only from Tauri commands, hence the
// allowances there.
#![cfg_attr(not(feature = "desktop"), allow(dead_code, unused_imports))]

// The window libraries need Common Controls v6, which only a manifest selects.
// Cargo gives the app's manifest to its binaries alone, so the unit tests name it.
#[cfg(all(test, feature = "desktop", target_env = "msvc"))]
#[link(name = "resource", kind = "dylib")]
unsafe extern "C" {}

#[cfg(feature = "desktop")]
mod account;
#[cfg(feature = "desktop")]
mod ai_edit;
#[cfg(feature = "desktop")]
mod composer_drafts;
mod agent_accounts;
mod agent_configs;
mod agent_data;
mod agent_keys;
#[cfg(feature = "desktop")]
mod agent_login_commands;
pub mod data_privacy;
#[cfg(feature = "desktop")]
mod updater;
mod archive_script;
mod project_overview;
#[cfg(feature = "desktop")]
mod desktop_links;
mod automations;
mod bots;
mod binpath;
mod chat_link;
mod cleanup;
#[cfg(feature = "desktop")]
mod cloud_catalog;
mod cloud_activity;
mod cloud_wake;
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
mod support_reports;
pub mod startup;
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
mod desktop_inbox;
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
mod machine_control;
#[cfg(windows)]
mod pipe_transport;
#[cfg(windows)]
mod win;
mod ipc;
mod paths;
mod private_fs;
pub(crate) mod platform_profile;
#[cfg(feature = "desktop")]
mod dictation;
mod notification_permission;
#[cfg(feature = "desktop")]
mod transparency;
#[cfg(feature = "desktop")]
mod drag_text;
#[cfg(feature = "desktop")]
mod transcription;
mod events;
mod files;
mod workspace_file;
mod foreground;
#[cfg(feature = "desktop")]
mod floating;
#[cfg(feature = "desktop")]
mod media;
mod media_types;
mod attachments;
mod branch_overview;
#[cfg(feature = "desktop")]
mod branch_step;
mod git;
mod fork_allocation;
#[cfg(feature = "desktop")]
mod repo_mirror;
mod checkpoints;
mod worktree_files;
mod sparse_checkout;
mod git_media;
mod github;
mod github_process;

/// Internal stdio transport entry, handled before starting a desktop/runtime.
/// Its parent owns admission and the process group, including all probes.
pub fn run_git_transport_cli() -> Option<i32> {
    #[cfg(unix)]
    { git::ssh::run_cli() }
    #[cfg(not(unix))]
    { None }
}
mod unfinished_merge;
mod merge_conflicts;
mod pr_associations;
mod github_identity;
mod ssh_containment;
mod harness;
pub mod hooks;
mod idle_agents;
mod issue_control;
#[cfg(feature = "desktop")]
mod issue_confirmation;
#[cfg(feature = "desktop")]
mod self_ui;
mod issue_pipeline;
mod issue_ops;
mod issues;
#[cfg(feature = "desktop")]
mod installation;
mod keychain;
#[cfg(feature = "desktop")]
mod environment_commands;
#[cfg(feature = "desktop")]
mod agent_config_commands;
#[cfg(feature = "desktop")]
mod configuration_commands;
#[cfg(feature = "desktop")]
mod configuration_watch;
#[cfg(feature = "desktop")]
mod secret_clipboard;
mod landed;
mod local_sharing;
pub mod local_runtime;
mod container_vm;
mod computer_targets;
#[cfg(unix)]
pub mod local_vm;
#[cfg(windows)]
#[path = "local_vm_windows.rs"]
pub mod local_vm;
mod machine_name;
mod direct_endpoints;
/// Where TCP 6768 listens and who it answers (PRO-487).
pub mod listen;
mod pairing_fingerprint;
mod memory_baseline;
mod merged_cleanup;
mod models;
mod names;
#[cfg(feature = "desktop")]
mod pairing;
/// The phone protocol, which the window and the runtime both serve (PRO-359).
mod phone;
#[cfg(feature = "desktop")]
mod machines;
/// The operating computer's side of pairing by code (`machines/pair.rs`),
/// outside the desktop feature: it needs only `machine_wire` and
/// `relay_e2ee`, and the two-machine tests (PRO-358) pair with it against
/// real runtimes. The desktop reaches it as `machines::pair`.
#[path = "machines/pair.rs"]
pub mod machine_pair;
pub mod power;
mod project_start;
mod project_templates;
mod pty;
/// Private inherited-descriptor helper, dispatched before application threads.
#[cfg(target_os = "linux")]
pub fn run_pty_supervisor() -> Option<i32> { pty::supervisor::dispatch() }
/// The same, from an executable's `.preinit_array`, before any thread can
/// exist. Every Linux executable that opens terminals lists it there.
#[cfg(target_os = "linux")]
pub extern "C" fn pty_supervisor_preinit(argc: libc::c_int, argv: *const *const libc::c_char, envp: *const *const libc::c_char) {
    pty::supervisor::dispatch_before_main(argc, argv, envp)
}
#[cfg(feature = "desktop")]
mod quit;
#[cfg(feature = "desktop")]
mod native_menu;
#[cfg(feature = "desktop")]
mod chat_windows;
pub mod relay_e2ee;
pub mod remote;
pub mod machine_account;
pub mod machine_host;
pub mod machine_wire;
mod session;
mod sidebar_activity;
mod session_archive;
mod session_usage;
mod session_names;
mod session_fork;
mod session_ops;
mod workspace_setup;
mod action_runner;
mod stray_processes;
pub mod serve;
pub mod serve_cli;
pub mod sink;
mod recovery;
mod reply_block;
mod recovery_log;
mod continuation;
pub mod skills;
mod store;
#[cfg(test)]
mod test_log;
mod status;
mod stats;
#[cfg(feature = "desktop")]
mod star_nag;
#[cfg(feature = "desktop")]
mod startup_error;
mod summaries;
mod terminal_perf;
#[cfg(feature = "desktop")]
mod work_claims;
mod orchestration;
mod orchestration_archive;
mod worker_report;
mod workspaces;
mod workspace_restore;
mod worktree_cleanup;
mod worktree_control;

#[cfg(feature = "desktop")]
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};

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
    /// Re-establishes `runtime` after a loss, without reloading a window.
    runtime_supervisor: local_runtime::supervisor::Supervisor,
    /// Whether the attached runtime still answers (#661).
    runtime_health: local_runtime::ui::Health,
    /// Whether the attached runtime is older than this app, and replacing it (#730).
    runtime_replacement: local_runtime::replace::Replacement,
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

/// Quitting fences the runtime's sharing and paired devices, on the main
/// thread. A runtime that has stopped answering is let go first, so those
/// fences fail at once instead of each waiting out a timeout (#661).
#[cfg(feature = "desktop")]
fn let_go_of_unresponsive_runtime(state: &AppState) {
    if state.runtime_health.unresponsive().is_some() {
        if let Some(runtime) = state.runtime() { runtime.disconnect(); }
    }
}

/// Tells the webview a `terminalx://` link is waiting (PRO-127, PRO-381,
/// PRO-130): it takes the links with `desktop_link_take`, so the event itself
/// carries nothing of them. Settings, tab, session, new-session and browser
/// links all come this one way, to one router.
#[cfg(feature = "desktop")]
const DESKTOP_LINK_REQUESTED: &str = "desktop_link_requested";

/// Keep a routed link for the webview and tell it one is waiting. A webview
/// that is not listening yet (the link launched the app) takes it when it starts.
#[cfg(feature = "desktop")]
fn offer_desktop_link(app: &tauri::AppHandle, link: desktop_links::DesktopLink) {
    app.state::<desktop_links::PendingDesktopLinks>().push(link);
    if let Err(error) = app.emit(DESKTOP_LINK_REQUESTED, ()) {
        log::warn!("tell the webview about a link: {error}");
    }
}

/// The links waiting for the webview, oldest first, once: each is
/// `{ kind, … }` with only what its route validated, or `invalid` with why.
#[cfg(feature = "desktop")]
#[tauri::command]
fn desktop_link_take(pending: tauri::State<'_, desktop_links::PendingDesktopLinks>) -> Vec<desktop_links::DesktopLink> {
    pending.take()
}

/// The link that opens a chat tab, in this build's scheme: the tab menu's "Copy link to this tab".
#[cfg(feature = "desktop")]
#[tauri::command]
fn tab_link_for(app: tauri::AppHandle, session_id: String, tab_id: String) -> Result<String, String> {
    desktop_links::DesktopLinks::for_identifier(&app.config().identifier)
        .tab_link_url(&session_id, &tab_id)
        .ok_or_else(|| "this tab has no link".to_owned())
}

/// The desktop's log file, `desktop.log` beside the runtime's (#716), kept
/// from setup on: the app's stderr goes nowhere once it is opened normally
/// (from the Dock, the Start menu or a desktop launcher). On Windows it is in
/// `%LOCALAPPDATA%\<identifier>\logs`.
#[cfg(feature = "desktop")]
static DESKTOP_LOG: std::sync::OnceLock<std::sync::Mutex<local_runtime::log_file::Log>> = std::sync::OnceLock::new();

#[cfg(all(any(target_os = "macos", windows), feature = "desktop"))]
fn install_window_pairing_consent(pairing: &std::sync::Arc<pairing::PairingManager>) {
    let keys = std::sync::Arc::downgrade(pairing);
    serve_cli::consent::speak_as_window(Box::new(move |create| {
        keys.upgrade()
            .ok_or_else(|| anyhow::anyhow!("TerminalX pairing is unavailable. Restart TerminalX and try again."))?
            .consent_key(create)
    }));
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // What the app starts (git, scripts) must not each flash a console window.
    #[cfg(windows)]
    win::process::windowless_console();
    let mut logger = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    logger.target(env_logger::Target::Pipe(Box::new(local_runtime::log_file::Tee::new(&DESKTOP_LOG))))
        .write_style(env_logger::WriteStyle::Never);
    logger.init();
    let host = Arc::new(harness::host::Host::new());
    let codex_models = Arc::new(harness::codex::models::Cache::default());
    let terminals = Arc::new(pty::Terminals::new());
    let status_state = Arc::new(status::StatusState::default());
    data_privacy::initialize();
    let account = Arc::new(account::AccountManager::default());
    let pairing = Arc::new(pairing::PairingManager::new(account.clone()));
    let machines = Arc::new(machines::Machines::default());
    pairing.attach_models(codex_models.clone());
    let cloud_workspaces = Arc::new(cloud_workspaces::CloudWorkspaceService::new(account.clone()));
    let paired = pairing.clone();
    let work_claims = Arc::new(work_claims::WorkClaims::new(account.clone(), move || paired.host_id()));
    let organization_members = Arc::new(organization_members::OrganizationMembersService::new(account.clone()));
    let agent_keys = Arc::new(cloud_agent_client::KeychainKeys::default());
    let cloud_agents = Arc::new(
        cloud_agent_client::CloudAgentClient::new(account.clone(), Arc::new(cloud_agent_client::CachedKeys::new(agent_keys.clone())))
            .unwrap_or_else(|error| startup_error::exit("open its cloud agent store", error)),
    );
    let organization_compute = Arc::new(organization_compute::OrganizationComputeService::new(account.clone()));
    let organization_github_app = Arc::new(organization_github_app::OrganizationGithubAppService::new(account.clone()));
    let workspace_config = Arc::new(organization_workspace_config::WorkspaceConfigService::new(account.clone()));
    let organization_environment = Arc::new(organization_environment::OrganizationEnvironmentService::new(account.clone()));
    let cloud_remote = cloud_remote::CloudRemote::new(account.clone(), cloud_workspaces.clone(), cloud_agents.clone());
    machines.set_account(account.clone());
    machines.set_phones(pairing.clone());
    let machine_connections = machines::connect::MachineConnections::new(machines.clone(), account.clone());
    let account_machines = Arc::new(machines::account::AccountPairing::new(machines.clone(), account.clone(), pairing.clone()));
    // The resource directory is only known once Tauri is up; the service
    // resolves the helper lazily, so it can be built before `setup`.
    let computer = Arc::new(computer::ComputerService::new(None));
    let browser = Arc::new(browser::BrowserRuntime::open().unwrap_or_else(|error| startup_error::exit("open its browser stores", error)));
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
        runtime_supervisor: Default::default(),
        runtime_health: Default::default(),
        runtime_replacement: Default::default(),
        window_endpoint: std::sync::OnceLock::new(),
    };

    let builder = tauri::Builder::default();
    // First, before any other plugin: on Windows and Linux a link the app is opened with while it runs
    // (a sign-in callback, a join or launch link) starts a second copy. This hands the link to the running
    // app, where the deep-link handler below takes it, brings the window forward and ends the second copy.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| account::focus_main_window(app)));
    builder
        .manage(media::MediaServer::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(transparency::plugin())
        .plugin(platform_profile::plugin())
        // Size, place and maximized state, but never the frame: that is the build's (none on Windows and Linux,
        // where the app draws its own), and a frame saved by an earlier version must not come back.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::DECORATIONS)
                .with_filter(|label| !chat_windows::is_chat_window(label))
                .build(),
        )
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
        .manage(desktop_links::PendingDesktopLinks::default())
        .manage(cloud_remote.clone())
        .manage(cloud_agents)
        .manage(machines.clone())
        .manage(machine_connections.clone())
        .manage(account_machines)
        .setup(move |app| {
            match app.path().app_log_dir() {
                Ok(dir) => if let Err(error) = local_runtime::log_file::keep(&DESKTOP_LOG, &dir.join("desktop.log")) {
                    log::warn!("the desktop log is not kept in a file: {error}");
                },
                Err(error) => log::warn!("the desktop log is not kept in a file: {error}"),
            }
            // A Codex sign-in home left by an app that crashed or was force-quit (PRO-79).
            #[cfg(feature = "desktop")]
            // With no private folder for them there are no homes of ours to sweep: a shared one is left alone.
            std::thread::spawn(|| if let Ok(parent) = codex_device_login::homes_parent() { codex_device_login::sweep_stale(&parent) });
            // Agent account directories a crash left before they were listed (#980).
            std::thread::spawn(agent_accounts::sweep);
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
            // Pairing codes and approvals from this window prove it is the
            // window, which has no terminal (PRO-369).
            #[cfg(any(target_os = "macos", windows))]
            install_window_pairing_consent(&pairing);
            // A runtime that cannot verify this window is relaunched by it (PRO-486).
            #[cfg(target_os = "macos")]
            local_runtime::window_consent::install_for(app.handle());
            machines.configure(Arc::new(app.handle().clone()), &app.config().identifier)?;
            machine_connections.watch(app.handle().clone());
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Windows and Linux learn the terminalx:// scheme from the app itself when it was not installed
                // by a package that registers it (a development build, an AppImage). An installed app’s own
                // registration is pointed at this copy again, which is the same.
                #[cfg(any(windows, target_os = "linux"))]
                if let Err(error) = app.deep_link().register_all() {
                    log::warn!("could not register the app’s link scheme: {error}");
                }
                let app_handle = app.handle().clone();
                let links = desktop_links::DesktopLinks::for_identifier(&app.config().identifier);
                let account = account.clone();
                let joining = pairing.clone();
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        if links.is_join_link(&url) { let _ = joining.set_pending_join(url.to_string()); }
                        else if let Some(link) = links.route(&url) { offer_desktop_link(&app_handle, link); }
                    }
                }
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if links.accepts_scheme(url.scheme()) {
                            account::focus_main_window(&app_handle);
                            if links.is_join_link(&url) {
                                if joining.set_pending_join(url.to_string()).is_err() { log::warn!("ignored invalid session link"); }
                            } else if let Some(link) = links.route(&url) {
                                log::info!("received TerminalX link");
                                offer_desktop_link(&app_handle, link);
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
            // Saved actions' exit codes, from every runtime pty_exit (PRO-363).
            action_runner::observe(sink.clone());
            let endpoint = hooks::prepare_control()?;
            let asking = app.handle().clone();
            let ask: issue_control::Ask = Arc::new(move |question: issue_control::Question| {
                tauri::async_runtime::block_on(issue_confirmation::ask(asking.clone(), question))
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
            store::settings::file::install(app.handle())?;
            let state = app.state::<AppState>();
            state.runtime_supervisor.start(app.handle())?;
            match local_runtime::supervisor::attach(app.handle()) {
                Ok(generation) => state.runtime_supervisor.attached(generation),
                Err(error) => {
                    *state.runtime_error.lock().unwrap() = format!("{error:#}");
                    log::error!("attach background runtime: {error:#}");
                    state.runtime_health.attach_failed(&error);
                    state.runtime_supervisor.unattached(&error);
                }
            }
            local_runtime::ui::watch(app.handle());
            local_runtime::replace::watch(app.handle());
            work_claims.start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            transparency::reduce_transparency,
            configuration_commands::configuration_resolve,
            configuration_commands::settings_files_list,
            configuration_commands::open_settings_file,
            configuration_watch::configuration_watch,
            configuration_commands::configuration_write,
            configuration_commands::configuration_review,
            agent_login_commands::agent_login_status,
            agent_login_commands::agent_login_save_key,
            agent_login_commands::agent_login_remove_key,
            agent_login_commands::agent_login_set_mode,
            agent_login_commands::agent_login_set_base_url,
            agent_login_commands::agent_login_verify,
            agent_login_commands::agent_login_shell_offer,
            agent_login_commands::agent_login_import_shell,
            agent_login_commands::agent_login_dismiss_shell,
            agent_login_commands::agent_login_tabs,
            agent_accounts::commands::agent_accounts_list,
            agent_accounts::commands::agent_accounts_add_start,
            agent_accounts::commands::agent_accounts_add_finish,
            agent_accounts::commands::agent_accounts_add_cancel,
            agent_accounts::commands::agent_accounts_open_page,
            agent_accounts::commands::agent_accounts_add_key,
            agent_accounts::commands::agent_accounts_relabel,
            agent_accounts::commands::agent_accounts_sign_in_again,
            agent_accounts::commands::agent_accounts_remove,
            agent_accounts::commands::agent_accounts_set_default,
            agent_accounts::commands::agent_accounts_set_auto_switch,
            agent_accounts::commands::agent_accounts_set_never_switch,
            agent_accounts::commands::agent_accounts_switch_log,
            agent_accounts::commands::agent_accounts_launch_choice,
            agent_accounts::commands::agent_accounts_readiness,
            environment_commands::environment_list,
            environment_commands::environment_reveal,
            environment_commands::environment_copy,
            environment_commands::environment_save,
            environment_commands::environment_delete,
            environment_commands::environment_read_file,
            environment_commands::environment_changed,
            local_runtime::ui::local_runtime_status,
            local_runtime::ui::local_runtime_log,
            local_runtime::ui::local_runtime_reconnect,
            local_runtime::ui::local_runtime_prove_window,
            local_runtime::ui::local_runtime_restart,
            #[cfg(unix)]
            local_runtime::window_consent::local_runtime_restart_for_window,
            local_runtime::ui::local_runtime_replace,
            local_runtime::ui::local_runtime_work,
            local_runtime::ui::local_runtime_plan_update,
            local_runtime::ui::local_runtime_settings,
            local_runtime::ui::set_local_runtime_quit_behavior,
            commands::list_projects,
            commands::local_vm_request,
            data_privacy::data_privacy_status,
            data_privacy::data_privacy_set,
            updater::app_update_check,
            updater::app_update_install,
            commands::repository_files_preview,
            commands::repository_folders,
            commands::account_status,
            commands::account_refresh_roles,
            commands::account_sign_in,
            commands::account_paste_callback,
            commands::organization_console_open,
            commands::account_sign_out,
            commands::organization_create,
            commands::organization_computer_save,
            commands::organization_select,
            commands::organization_delete,
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
            commands::phase2_desktop_contracts_available,
            commands::cloud_workspace_follow_put,
            commands::cloud_workspace_follow_delete,
            commands::cloud_workspace_reassign,
            commands::desktop_presence_put,
            commands::desktop_presence_read,
            commands::desktop_inbox,
            commands::desktop_inbox_stream,
            commands::desktop_inbox_receipts,
            commands::cloud_workspace_read_marker,
            commands::cloud_workspace_restart,
            commands::cloud_workspace_details,
            commands::cloud_workspace_idle_suspend,
            commands::cloud_workspace_set_idle_suspend,
            commands::cloud_workspace_operation,
            commands::cloud_workspace_operation_cancel,
            cloud_remote::cloud_remote_attach,
            machines::connect::machine_remote_attach,
            machines::connect::machines_connections,
            machines::connect::machines_reconnect,
            machines::connect::machines_remove,
            machines::connect::machines_rename,
            cloud_remote::cloud_remote_send,
            cloud_remote::cloud_remote_activate,
            cloud_remote::cloud_remote_detach,
            cloud_remote::cloud_port_forward,
            cloud_remote::cloud_port_unforward,
            cloud_remote::cloud_port_forwards,
            cloud_remote::cloud_port_settings,
            cloud_remote::cloud_port_set_settings,
            support_reports::support_report_preview,
            support_reports::support_report_submit,
            support_reports::support_report_local,
            support_reports::support_report_copy,
            cloud_diagnostics::commands::cloud_diagnostics,
            cloud_diagnostics::commands::cloud_connection_diagnostics,
            cloud_diagnostics::commands::cloud_diagnostics_export,
            startup::commands::startup_diagnostics_status,
            startup::commands::startup_diagnostics_policy,
            startup::commands::startup_diagnostics_probe,
            startup::commands::startup_diagnostics_dismiss,
            startup::commands::startup_diagnostics_preview,
            startup::commands::startup_diagnostics_export,
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
            machines::machines_host_status,
            machines::machines_set_allow_operating,
            machines::machines_set_listen,
            machines::machines_create_code,
            machines::machines_approve,
            machines::machines_decline,
            machines::machines_revoke,
            machines::machines_disconnect,
            machines::machines_let_back,
            machines::machines_activity,
            machines::machines_inspect_code,
            machines::machines_pair,
            machines::machines_cancel_pairing,
            machines::machines_list,
            machines::machines_set_route,
            machines::account::machines_account_list,
            machines::account::machines_account_request,
            machines::account::machines_account_cancel,
            machines::account::machines_account_finish,
            machines::machines_app_update_report,
            commands::pairing_retry_relay,
            commands::session_share_create,
            commands::session_share_status,
            commands::session_share_change,
            commands::session_join_pending,
            desktop_link_take,
            tab_link_for,
            commands::session_guest_join,
            commands::session_guest_send,
            commands::session_guest_leave,
            commands::pairing_generate,
            commands::pairing_revoke,
            commands::pairing_approve,
            commands::pairing_decline,
            commands::pairing_disconnect,
            commands::pairing_set_keep_awake,
            commands::machine_name,
            commands::set_machine_name,
            commands::add_project,
            commands::chats_dir,
            commands::remove_project,
            commands::select_project,
            commands::github_repositories,
            commands::project_clone,
            commands::project_clone_cancel,
            commands::project_start_defaults,
            commands::project_create,
            commands::project_templates,
            commands::project_template_add,
            commands::project_template_remove,
            commands::list_sessions,
            commands::session_row_statuses,
            commands::local_sections,
            commands::edit_local_section,
            commands::automations_list,
            commands::automation_runs,
            commands::automation_issue_states,
            commands::automation_issue_preview,
            commands::automation_source_preview,
            commands::automation_create,
            commands::automation_update,
            commands::automation_delete,
            commands::automation_precheck_try,
            commands::automation_run_now,
            commands::bot_list,
            commands::bot_get,
            commands::bot_templates,
            commands::bot_create,
            commands::bot_update,
            commands::bot_delete,
            commands::bot_pause,
            commands::bot_resume,
            commands::bots_pause_all,
            commands::bots_resume_all,
            commands::bot_role_read,
            commands::bot_role_write,
            commands::bot_memory,
            commands::bot_home_chat,
            commands::bot_new_chat,
            commands::bot_dismiss_resume,
            commands::bot_items,
            commands::bot_item,
            commands::bots_needs_you,
            commands::bots_pause_held,
            commands::bot_item_answer,
            commands::bot_item_comment,
            commands::bot_item_give,
            commands::bot_item_stop,
            commands::bot_item_resend,
            commands::bot_item_reopen,
            commands::bot_spent_today,
            commands::bot_move,
            commands::bot_suggestions,
            commands::bot_suggestion_start,
            commands::bot_suggestion_dismiss,
            commands::bot_handoffs,
            commands::bot_channels,
            commands::bot_chat_apps,
            commands::bot_chat_app_connect,
            commands::bot_chat_app_disconnect,
            commands::bot_chat_app_link,
            commands::bot_chat_app_unlink,
            commands::bot_chat_app_also_sends,
            commands::bot_handoff_stop,
            commands::bot_handoff_resend,
            commands::bot_item_hand,
            commands::bot_brief,
            commands::bot_brief_write,
            commands::bot_duties,
            commands::bot_duty_week,
            commands::bot_duty_kept_log,
            commands::bot_duty_save,
            commands::bot_duty_switch,
            commands::bot_duty_delete,
            commands::bot_duty_duplicate,
            commands::bot_duty_run,
            commands::bot_duty_try_check,
            commands::bot_quiet_hours,
            commands::session_summaries,
            commands::stats_usage_snapshot,
            commands::app_activity_summary,
            commands::stats_usage_refresh,
            commands::create_session,
            commands::workspace_setup,
            commands::action_run,
            commands::action_states,
            commands::workspace_ports,
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
            commands::sidebar_order,
            commands::set_sidebar_order,
            commands::cloud_pins,
            commands::edit_cloud_pins,
            commands::set_tab_layout,
            commands::tab_resume_conversation,
            commands::pane_agents,
            commands::rename_session,
            commands::set_session_archived,
            commands::set_sessions_archived,
            commands::set_shown_session,
            commands::archive_idle_sessions,
            commands::set_session_pinned,
            commands::set_session_status,
            commands::set_active_tab,
            commands::delete_session,
            commands::list_harnesses,
            commands::check_agent_readiness,
            commands::agent_latest_version,
            commands::agent_setup_start,
            commands::agent_setup_running,
            commands::list_skills,
            commands::skill_detail,
            commands::agent_configs_compare,
            commands::agent_configs_preview,
            commands::agent_configs_apply,
            commands::work_status,
            commands::branch_overview,
            commands::project_forge,
            commands::branch_fetch,
            commands::branch_merge_into,
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
            commands::review_comments,
            commands::diff_media_content,
            commands::log_commits,
            commands::load_tab_events,
            commands::prepare_continuation,
            commands::send_message,
            commands::store_attachments,
            commands::read_attachment_part,
            commands::inspect_attachments,
            commands::save_attachment_copy,
            commands::report_send_shown,
            commands::report_terminal_view,
            commands::report_recovery_ui,
            commands::resend_unsent,
            commands::resend_message,
            commands::submit_waiting_prompt,
            commands::interrupt_turn,
            commands::stop_tab,
            commands::reset_chat,
            commands::tab_handoff,
            commands::tab_to_terminal,
            commands::ensure_tab_started,
            commands::tab_pane,
            commands::cancel_queued,
            commands::send_queued_now,
            commands::change_held_queue,
            commands::list_queued,
            commands::respond_permission,
            commands::answer_questions,
            commands::answer_terminal_prompt,
            commands::set_tab_model,
            commands::set_tab_permission_mode,
            commands::set_tab_effort,
            commands::mark_tab_read,
            commands::set_tab_unread,
            commands::tab_status,
            commands::list_models,
            commands::frontend_log,
            commands::search_files,
            commands::count_files,
            commands::list_files,
            commands::list_slash_commands,
            commands::read_image_file,
            drag_text::dropped_text,
            drag_text::terminal_quote_style,
            commands::invalidate_file_index,
            commands::git_commit,
            commands::git_stage_paths,
            commands::git_unstage_paths,
            commands::git_unstage_all,
            commands::git_apply_hunk,
            commands::git_hunk_count,
            commands::generate_commit_message,
            ai_edit::ai_edit,
            ai_edit::ai_edit_cancel,
            composer_drafts::composer_drafts_load,
            composer_drafts::composer_draft_save,
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
            commands::branch_step_refresh,
            commands::branch_step_account,
            commands::branch_step_action,
            commands::git_has_remote,
            commands::git_add_remote,
            commands::gh_connection_status,
            commands::gh_login_start,
            commands::gh_create_repository,
            commands::git_pull,
            commands::git_discard,
            commands::turn_checkpoint,
            commands::keep_turn,
            commands::undo_turn,
            commands::restore_undo,
            commands::unfinished_merge,
            commands::commit_merge,
            commands::abort_merge,
            commands::merge_conflict_file,
            commands::resolve_merge_conflict,
            commands::mark_conflict_resolved,
            commands::git_checkout,
            commands::git_branch_here,
            commands::working_changes,
            commands::working_change_sets,
            commands::pr_list,
            commands::pr_search,
            commands::pr_attach,
            commands::pr_associations,
            commands::pr_associations_batch,
            commands::pr_link_candidates,
            commands::pr_link,
            commands::pr_unlink,
            commands::pr_details,
            commands::pr_conversation,
            commands::pr_conversation_action,
            commands::pr_reviewer_search,
            commands::pr_review_threads,
            commands::pr_review_files,
            commands::pr_review_resolve,
            commands::pr_review_reply,
            commands::pr_landed,
            commands::pr_create,
            commands::pr_merge,
            commands::pr_delete_branch,
            commands::pr_ready,
            commands::pr_check_authority,
            commands::pr_check_log,
            commands::pr_check_rerun,
            commands::pr_check_fix_attachment,
            commands::gh_available,
            star_nag::star_nag_ready,
            star_nag::star_nag_input,
            star_nag::star_nag_dismiss,
            star_nag::star_nag_act,
            commands::pty_spawn,
            commands::pty_local_links,
            commands::pty_shells,
            commands::pty_rename,
            commands::pty_set_docked,
            commands::save_terminal_selection,
            commands::pty_busy,
            commands::listening_sessions,
            commands::pty_write,
            commands::pty_attach,
            commands::pty_attach_sized,
            commands::pty_detach,
            commands::pty_detach_all,
            commands::pty_ack,
            commands::pty_resize,
            commands::mobile_terminal_drivers,
            commands::pty_kill,
            commands::terminal_perf_reply,
            commands::cloud_control_reply,
            self_ui::self_ui_claim,
            self_ui::self_ui_validate,
            self_ui::self_ui_reply,
            self_ui::self_ui_start,
            self_ui::self_ui_grants,
            self_ui::self_ui_revoke,
            issue_confirmation::issue_confirmation_pending,
            issue_confirmation::issue_confirmation_reply,
            commands::cloud_control_setting,
            commands::cloud_control_set_setting,
            commands::cloud_control_confirm,
            commands::list_dir,
            media::open_media_file,
            media::close_media_file,
            commands::read_text_file,
            commands::read_whole_text_file,
            commands::export_file,
            commands::write_text_file,
            commands::create_text_file,
            commands::file_mtime,
            commands::inspect_local_path,
            commands::open_local_path,
            commands::search_text,
            commands::replace_text,
            commands::fork_session,
            commands::fork_turn,
            commands::dictation_available,
            commands::notification_permission,
            commands::dictation_start,
            commands::dictation_stop,
            commands::update_project,
            commands::set_project_logo,
            commands::list_workspaces,
            commands::repo_mirror_status,
            commands::repo_mirror_start,
            commands::repo_mirror_stop,
            commands::preview_workspace_name,
            commands::rename_workspace,
            commands::rename_branch,
            commands::local_vm_status,
            commands::local_vm_start,
            commands::local_vm_stop,
            commands::local_vm_reset,
            commands::local_vm_start_runtime,
            commands::adopt_agent_title,
            commands::project_overview,
            commands::copy_text,
            commands::workspace_disposition,
            commands::remove_workspace,
            commands::preview_workspace_restore,
            commands::restore_workspace,
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
            commands::agent_settings,
            commands::set_agent_idle_stop_minutes,
            agent_config_commands::agent_executable,
            agent_config_commands::set_agent_executable,
            agent_config_commands::agent_config_file,
            agent_config_commands::open_agent_config_file,
            agent_config_commands::reveal_agent_path,
            agent_config_commands::opencode_overview,
            agent_config_commands::opencode_catalog_models,
            agent_config_commands::opencode_connect,
            agent_config_commands::opencode_disconnect,
            agent_config_commands::opencode_add_model,
            agent_config_commands::opencode_remove_model,
            agent_config_commands::opencode_open_logs,
            commands::set_read_only_commands,
            commands::diagnostics_settings,
            commands::set_recovery_incidents,
            commands::recovery_incidents_summary,
            commands::recovery_incidents_export,
            commands::clear_recovery_incidents,
            commands::conversation_settings,
            commands::set_archive_idle_days,
            commands::experimental_settings,
            commands::experimental_unsupported,
            store::settings::file::settings_file_status,
            store::settings::file::update_user_preferences,
            store::settings::file::create_settings_file,
            store::settings::file::reset_user_setting,
            commands::set_experimental_settings,
            commands::orchestrator_settings,
            commands::set_orchestrator_settings,
            commands::orchestrator_tier_models,
            commands::orchestration_run_for_session,
            commands::orchestration_runs,
            commands::orchestration_create,
            commands::orchestrator_limits,
            commands::orchestration_approve,
            commands::orchestration_start,
            commands::orchestration_stop,
            commands::orchestration_update_plan,
            commands::orchestration_merge,
            commands::orchestration_send_back,
            commands::orchestration_resolve_in_lead,
            commands::orchestration_take_over,
            commands::orchestration_finish,
            commands::orchestration_finish_widens,
            commands::orchestration_widen,
            commands::orchestration_note,
            commands::orchestration_skip,
            commands::orchestration_set_limits,
            commands::orchestration_resume,
            commands::session_usage,
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
            quit::reply_to_quit_prompt,
            commands::issues_list,
            commands::issue_pipelines_list,
            commands::issue_pipeline_start,
            commands::issue_pipeline_attach,
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
            transcription::commands::transcription_personalization_load,
            transcription::commands::transcription_detector,
            transcription::commands::transcription_personalization_save,
            transcription::commands::transcription_personalization_reset,
            transcription::commands::transcription_personalization_export,
            transcription::commands::transcription_project_terms,
            transcription::commands::transcription_learn,
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
            commands::tab_note_typing,
            commands::status_codex_reset,
            commands::status_resource_overview,
            native_menu::set_native_menu,
            native_menu::app_menu_item,
            native_menu::posix_shell_missing,
            native_menu::native_window_action,
            native_menu::forward_menu_action,
            chat_windows::new_chat_window,
            chat_windows::chat_window_open_in_main,
            commands::status_resource_sample,
            commands::status_resource_kill,
            browser::ui::browser_pages,
            browser::ui::browser_open_tab,
            browser::ui::browser_close_page,
            browser::ui::browser_activate_page,
            browser::ui::browser_navigate,
            browser::ui::browser_screencast,
            browser::ui::browser_input,
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
            native_menu::dispatch(app, event.id().as_ref());
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
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
                quit::main_view_lost();
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
                if chat_windows::is_chat_window(window.label()) {
                    let _ = window.app_handle().emit_to("main", "chat_window_closed", window.label());
                }
                // Its machine connections: a closed window runs no cleanup (PRO-345).
                if let Some(remote) = window.try_state::<Arc<cloud_remote::CloudRemote>>() {
                    remote.release_holder(window.label());
                }
                if let Some(state) = window.try_state::<AppState>() {
                    if let Some(runtime) = state.runtime() { runtime.detach_window(window.label()); }
                    if window.label() == "main" {
                        quit::main_view_lost();
                        // The app goes with it: nothing may attach again.
                        state.runtime_supervisor.halt();
                        let_go_of_unresponsive_runtime(&state);
                        state.pairing.stop();
                        if let Some(runtime) = state.runtime() { runtime.disconnect(); }
                        for (label, secondary) in window.app_handle().webview_windows() {
                            if label == floating::LABEL || chat_windows::is_chat_window(&label) { let _ = secondary.destroy(); }
                        }
                        state.computer.shutdown();
                        state.browser.shutdown();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| startup_error::exit("start its window", error))
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
                agent_accounts::login::shutdown_all();
                let state = app.state::<AppState>();
                state.dictation.shutdown(&state.transcription.engine);
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
                state.runtime_supervisor.halt();
                let_go_of_unresponsive_runtime(&state);
                state.pairing.stop();
                if let Some(runtime) = state.runtime() { runtime.disconnect(); }
                state.browser.shutdown();
            }
        });
}
