//! Tauri commands behind the browser pane and Settings.

use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use super::pages::PageInfo;
use super::{ops, BrowserRuntime};

type CmdResult<T> = Result<T, String>;

fn runtime(state: &State<'_, crate::AppState>) -> Arc<BrowserRuntime> {
    state.browser.clone()
}

fn err(e: impl std::fmt::Display) -> String {
    format!("{e}")
}

#[tauri::command]
pub fn browser_pages(state: State<'_, crate::AppState>) -> Vec<PageInfo> {
    runtime(&state).pages.infos(None)
}

#[tauri::command]
pub async fn browser_open_tab(state: State<'_, crate::AppState>, workspace: String, url: Option<String>, profile: Option<String>) -> CmdResult<Value> {
    let rt = runtime(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = super::control::canonical(&workspace);
        let profile = profile.unwrap_or_else(|| super::profiles::DEFAULT_PROFILE_ID.into());
        ops::tab_create(&rt, &workspace, url.as_deref(), &profile).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn browser_close_page(state: State<'_, crate::AppState>, page_id: String) -> CmdResult<()> {
    let rt = runtime(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(page) = rt.pages.get(&page_id) else { return Ok(()) };
        let target = rt.target(page).map_err(err)?;
        ops::tab_close(&rt, &target).map(|_| ()).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Make a page its workspace's active one, optionally raising its window.
#[tauri::command]
pub async fn browser_activate_page(state: State<'_, crate::AppState>, page_id: String, focus: bool) -> CmdResult<()> {
    let rt = runtime(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let page = rt.pages.get(&page_id).ok_or_else(|| "The page is no longer open.".to_string())?;
        let target = rt.target(page).map_err(err)?;
        ops::tab_switch(&rt, &target, focus).map(|_| ()).map_err(err)
    })
    .await
    .map_err(err)?
}

/// `goto`, `back`, `forward` or `reload` from the pane's toolbar.
#[tauri::command]
pub async fn browser_navigate(state: State<'_, crate::AppState>, page_id: String, action: String, url: Option<String>) -> CmdResult<Value> {
    let rt = runtime(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let page = rt.pages.get(&page_id).ok_or_else(|| "The page is no longer open.".to_string())?;
        let target = rt.target(page).map_err(err)?;
        match action.as_str() {
            "goto" => ops::goto(&rt, &target, &serde_json::json!({"url": url})).map_err(err),
            "back" | "forward" | "reload" => ops::history(&rt, &target, &action).map_err(err),
            other => Err(format!("unknown navigation {other}")),
        }
    })
    .await
    .map_err(err)?
}

/// Start or stop the live preview of a page.
#[tauri::command]
pub async fn browser_screencast(state: State<'_, crate::AppState>, page_id: String, live: bool) -> CmdResult<()> {
    let rt = runtime(&state);
    tauri::async_runtime::spawn_blocking(move || {
        if live {
            rt.screencasts.start(rt.clone(), &page_id).map_err(err)
        } else {
            rt.screencasts.stop(&page_id);
            Ok(())
        }
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn browser_runtime_status(state: State<'_, crate::AppState>) -> CmdResult<super::binary::RuntimeStatus> {
    let rt = runtime(&state);
    tauri::async_runtime::spawn_blocking(move || rt.status()).await.map_err(err)
}

/// `agent-browser install`: fetch a Chromium when no system browser exists.
#[tauri::command]
pub async fn browser_install_browser(state: State<'_, crate::AppState>) -> CmdResult<super::binary::RuntimeStatus> {
    let rt = runtime(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let binary = super::binary::require().map_err(err)?;
        super::binary::install_browser(&binary, &rt.bridge.env).map_err(err)?;
        Ok(rt.status())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn browser_profiles(state: State<'_, crate::AppState>) -> Vec<super::profiles::BrowserProfile> {
    runtime(&state).profiles.list()
}
