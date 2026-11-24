//! Unsent composer text of local tabs, kept across a restart. One owner-only
//! file per tab, so two windows never overwrite each other's drafts. Only a tab
//! this computer's session index knows is kept: a cloud tab has its own cache.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use anyhow::Result;

const MAX_DRAFT_CHARS: usize = 64_000;
const MAX_DRAFTS: usize = 200;

fn folder() -> Result<PathBuf> {
    crate::store::ensure_dir(crate::store::root()?.join("composer-drafts"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn local_tabs() -> Result<HashSet<String>> {
    Ok(crate::store::index::load()?.into_iter().flat_map(|session| session.tabs.into_iter().map(|tab| tab.id)).collect())
}

fn save(tab_id: &str, text: &str) -> Result<()> {
    if !valid_id(tab_id) {
        return Ok(());
    }
    let path = folder()?.join(format!("{tab_id}.json"));
    if text.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        };
    }
    if text.chars().count() > MAX_DRAFT_CHARS || !local_tabs()?.contains(tab_id) {
        return Ok(());
    }
    crate::store::write_json(&path, &text)
}

/// Every kept draft of a tab that still exists. Those of closed tabs are removed.
fn load() -> Result<HashMap<String, String>> {
    let tabs = local_tabs()?;
    let mut drafts = HashMap::new();
    for entry in std::fs::read_dir(folder()?)?.flatten() {
        let path = entry.path();
        let id = path.file_stem().and_then(|stem| stem.to_str()).filter(|id| valid_id(id)).map(str::to_owned);
        let Some(id) = id.filter(|id| tabs.contains(id) && path.extension().is_some_and(|ext| ext == "json")) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if drafts.len() < MAX_DRAFTS {
            if let Ok(Some(text)) = crate::store::read_json::<String>(&path) {
                drafts.insert(id, text);
            }
        }
    }
    Ok(drafts)
}

#[tauri::command]
pub async fn composer_drafts_load() -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(|| load().map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn composer_draft_save(tab_id: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save(&tab_id, &text).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_that_is_not_a_plain_id_never_becomes_a_path() {
        for id in ["", "../escape", "a/b", "a\\b", "C:", "a.b", &"x".repeat(129)] {
            assert!(!valid_id(id), "{id:?}");
        }
        assert!(valid_id("2f1c-tab_9"));
    }

    #[test]
    fn only_a_known_tabs_draft_is_kept_and_closing_it_lets_go() {
        let _home = crate::store::temp_home();
        save("not-a-local-tab", "private").unwrap();
        assert!(load().unwrap().is_empty(), "a cloud tab's or an issue's key is not kept");
        let stray = folder().unwrap().join("closed-tab.json");
        crate::store::write_json(&stray, &"left behind").unwrap();
        assert!(load().unwrap().is_empty());
        assert!(!stray.exists(), "a closed tab's draft is removed");
        save("../escape", "x").unwrap();
        assert!(!crate::store::root().unwrap().join("escape.json").exists());
    }
}
