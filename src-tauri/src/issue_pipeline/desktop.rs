//! The pipeline in the desktop app: its host built from the window's state,
//! the hooks a turn ending calls, and the poller.

use std::sync::Arc;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use super::host::LocalHost;
use super::{engine, store};

pub fn host(app: &AppHandle) -> Result<LocalHost> {
    let manager = app.state::<crate::AppState>().manager().context("session manager is not ready")?;
    Ok(LocalHost::new(Arc::new(app.clone()), manager))
}

fn off_thread(app: &AppHandle, work: impl FnOnce(&LocalHost) + Send + 'static) {
    let Ok(host) = host(app) else {
        return;
    };
    let _ = std::thread::Builder::new().name("issue-pipeline".into()).spawn(move || work(&host));
}

/// A turn ended. Called from the hook thread, which must get back to the
/// agent at once: everything a pipeline does about it happens elsewhere.
pub fn turn_completed(app: &AppHandle, session_id: &str, tab_id: &str, final_message: Option<String>) {
    if !store::takes_part(session_id, tab_id) {
        return;
    }
    let (session_id, tab_id) = (session_id.to_string(), tab_id.to_string());
    off_thread(app, move |host| engine::turn_completed(host, &session_id, &tab_id, final_message.as_deref()));
}

pub fn turn_failed(app: &AppHandle, session_id: &str, tab_id: &str, interrupted: bool) {
    if !store::takes_part(session_id, tab_id) {
        return;
    }
    let (session_id, tab_id) = (session_id.to_string(), tab_id.to_string());
    let detail = engine::turn_failure(interrupted);
    off_thread(app, move |host| engine::turn_failed(host, &session_id, &tab_id, detail));
}
