//! The built-in browser: a Chromium the app manages through the bundled
//! `agent-browser` runtime, shared by the reader (a headed window) and the
//! agents (the `terminalx` browser verbs).
//!
//! ```text
//! terminalx CLI ──JSON-RPC──▶ control.rs ──▶ browser::control (target resolution)
//!                                              │
//!                                              ▼
//!                                         browser::ops (typed commands)
//!                                              │
//!                                         browser::bridge  one agent-browser
//!                                              │           session per profile
//!                                              ▼
//!                                    agent-browser daemon ──▶ Chromium (headed,
//!                                                              persistent profile)
//! ```
//!
//! The app keeps its own page ids (`bp-…`) and maps them to agent-browser's
//! stable tab ids; pages belong to the workspace that opened them, and the
//! workspace's active page is what unqualified commands target.

pub mod binary;
pub mod bridge;
pub mod cdp;
pub mod cli;
pub mod control;
#[cfg(test)]
mod e2e;
pub mod environment;
pub mod ops;
pub mod pages;
pub mod process;
pub mod profiles;
pub mod screencast;
pub mod sweep;
pub mod ui;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use bridge::{Bridge, Session};
use pages::{BrowserPage, PageInfo, PageStore, TabListing};
use profiles::ProfileStore;

pub const PAGES_CHANGED_EVENT: &str = "browser_pages_changed";
pub const FRAME_EVENT: &str = "browser_frame";
pub const SCREENCAST_STATE_EVENT: &str = "browser_screencast_state";

/// A browser failure with the typed code agents branch on.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BrowserError {
    pub code: String,
    pub message: String,
}

impl BrowserError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BrowserError {}

pub type BrowserResult<T> = Result<T, BrowserError>;

/// A page together with the session that owns it.
#[derive(Clone)]
pub struct Target {
    pub page: BrowserPage,
    pub session: Arc<Session>,
}

/// What the UI receives whenever the page list changes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagesEvent {
    pub pages: Vec<PageInfo>,
}

pub struct BrowserRuntime {
    pub bridge: Bridge,
    pub pages: PageStore,
    pub profiles: ProfileStore,
    pub root: PathBuf,
    pub screencasts: screencast::Screencasts,
    app: Mutex<Option<AppHandle>>,
}

impl BrowserRuntime {
    /// Open the stores under `$RACCOON_HOME/browser`. Pages remembered from a
    /// previous run are dropped: their browser is gone (or about to be swept).
    pub fn open() -> anyhow::Result<Self> {
        let home = crate::store::root()?;
        let root = crate::store::ensure_dir(home.join("browser"))?;
        let inherited: HashMap<String, String> = std::env::vars().collect();
        let env = environment::create(&inherited, &home);
        let pages = PageStore::open(root.join("pages.json"))?;
        let _ = pages.reset();
        let profiles = ProfileStore::open(root.clone())?;
        Ok(Self {
            bridge: Bridge::new(env),
            pages,
            profiles,
            root,
            screencasts: screencast::Screencasts::default(),
            app: Mutex::new(None),
        })
    }

    pub fn attach(&self, app: AppHandle) {
        *self.app.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    }

    pub fn app(&self) -> Option<AppHandle> {
        self.app.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Close daemons a crashed run left behind, off the startup path.
    pub fn sweep_orphans(self: &Arc<Self>) {
        let rt = self.clone();
        std::thread::Builder::new()
            .name("agent-browser-sweep".into())
            .spawn(move || {
                let Some(binary) = binary::locate() else { return };
                let live: Vec<String> = rt.bridge.live_session_names();
                let closed = sweep::sweep(&binary, &rt.bridge.env, |name| live.iter().any(|l| l == name));
                if !closed.is_empty() {
                    log::info!("closed orphaned agent-browser sessions: {}", closed.join(", "));
                }
            })
            .ok();
    }

    /// Keep every launched daemon inside its idle bound and the page list in
    /// step with the browser window, for as long as the app runs.
    pub fn start_keepalive(self: &Arc<Self>) {
        let rt = self.clone();
        std::thread::Builder::new()
            .name("agent-browser-keepalive".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(environment::KEEPALIVE_INTERVAL_SECS));
                for session in rt.bridge.launched_sessions() {
                    if let Err(e) = rt.reconcile_session(&session, None) {
                        log::debug!("browser keepalive {}: {e}", session.name);
                    }
                }
            })
            .ok();
    }

    /// The session for a profile, with its directories ready.
    pub fn session_for(&self, profile_id: &str) -> BrowserResult<Arc<Session>> {
        let profile = self.profiles.get(profile_id)?;
        let data_dir = crate::store::ensure_dir(self.profiles.data_dir(&profile.id)).map_err(|e| BrowserError::new("browser_error", format!("{e:#}")))?;
        let download_dir = crate::store::ensure_dir(self.profiles.download_dir(&profile.id)).map_err(|e| BrowserError::new("browser_error", format!("{e:#}")))?;
        Ok(self.bridge.session(&profile.id, data_dir, download_dir))
    }

    pub fn target(&self, page: BrowserPage) -> BrowserResult<Target> {
        let session = self.session_for(&page.profile_id)?;
        Ok(Target { page, session })
    }

    /// Ask the daemon for its tabs and fold them into the page store,
    /// announcing the result to the UI when anything moved.
    pub fn reconcile_session(&self, session: &Session, fallback_workspace: Option<&str>) -> BrowserResult<Vec<TabListing>> {
        let listing = self.bridge.with_session(session, |ctx| {
            let value = ctx.run(&["tab", "list"], bridge::ExecOptions::default())?;
            let tabs = parse_tab_listing(&value);
            ctx.lane.active_tab = tabs.iter().find(|t| t.active).map(|t| t.tab_id.clone());
            Ok::<_, BrowserError>(tabs)
        })?;
        let fallback = fallback_workspace.map(String::from).or_else(|| {
            // A tab the reader opened joins the workspace that last used this
            // profile, so it shows up somewhere rather than nowhere.
            self.pages.in_profile(&session.profile_id).into_iter().rev().find_map(|p| p.workspace_path)
        });
        if self.pages.reconcile(&session.profile_id, &listing, fallback.as_deref())? {
            self.announce_pages();
        }
        Ok(listing)
    }

    pub fn announce_pages(&self) {
        if let Some(app) = self.app() {
            let _ = app.emit(PAGES_CHANGED_EVENT, PagesEvent { pages: self.pages.infos(None) });
        }
    }

    pub fn emit(&self, event: &str, payload: impl Serialize + Clone) {
        if let Some(app) = self.app() {
            let _ = app.emit(event, payload);
        }
    }

    /// Everything a workspace deletion must drop: its pages, closing the
    /// browser tabs behind them.
    pub fn forget_workspace(&self, workspace: &str) {
        let pages = self.pages.infos(Some(workspace));
        for info in pages {
            if let Ok(target) = self.target(info.page.clone()) {
                let _ = ops::tab_close(self, &target);
            }
        }
        let _ = self.pages.remove_workspace(workspace);
        self.announce_pages();
    }

    /// Quit: close every browser the app launched, inside the quit budget.
    pub fn shutdown(&self) {
        self.screencasts.stop_all();
        self.bridge.close_all();
        let _ = self.pages.reset();
    }

    pub fn status(&self) -> binary::RuntimeStatus {
        let binary = binary::locate();
        let version = binary.as_deref().and_then(|b| binary::version(b, &self.bridge.env));
        binary::RuntimeStatus {
            binary: binary.map(|b| b.to_string_lossy().into_owned()),
            version,
            expected_version: binary::EXPECTED_VERSION.into(),
            browser: binary::detect_browser(),
            socket_dir: self.bridge.env.socket_dir.as_ref().map(|d| d.to_string_lossy().into_owned()),
            owns_socket_dir: self.bridge.env.owns_socket_directory,
            live_sessions: self.bridge.live_session_names(),
        }
    }
}

/// agent-browser's `tab list` payload → listings.
pub fn parse_tab_listing(value: &Value) -> Vec<TabListing> {
    value
        .get("tabs")
        .and_then(Value::as_array)
        .map(|tabs| tabs.iter().filter_map(|t| serde_json::from_value::<TabListing>(t.clone()).ok()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_browser_tab_listings() {
        let value: Value = serde_json::from_str(r#"{"tabs":[{"active":true,"label":null,"tabId":"t1","title":"Smoke","type":"page","url":"file:///a"},{"active":false,"tabId":"t2","title":"about:blank","type":"page","url":"about:blank"}]}"#).unwrap();
        let tabs = parse_tab_listing(&value);
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0], TabListing { tab_id: "t1".into(), url: "file:///a".into(), title: "Smoke".into(), active: true });
        assert!(!tabs[1].active);
    }
}
