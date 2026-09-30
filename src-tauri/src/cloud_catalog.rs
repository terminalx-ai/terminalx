//! The saved cloud catalog (PRO-57): what the sidebar last knew about each
//! organization's cloud workspaces and repositories, so a relaunch renders
//! them before the network answers.
//!
//! - One JSON file per signed-in user, `<TERMINALX_HOME>/cloud/<userId>/catalog.json`,
//!   rewritten atomically. The webview owns its shape; this side only checks
//!   that it is a JSON object of a sane size.
//! - The user is the signed-in account's, never the webview's say. Every call
//!   carries the webview's context revision, and a call for an account that is
//!   no longer current is refused, so a late write never lands in the next
//!   account's file.
//! - When a different user signs in, what an earlier user kept is deleted on
//!   the first load. The same user signing in again keeps it.
//! - It holds workspace names, states and repository names; no keys, tokens or
//!   transcripts.

use std::path::PathBuf;

use serde_json::Value;

/// A catalog of a few hundred workspaces is well under this.
const CATALOG_LIMIT: usize = 4 * 1024 * 1024;
const FILE: &str = "catalog.json";

/// A user id as the account service issues them; nothing that could leave the directory.
fn valid_user(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub struct CatalogFiles {
    root: PathBuf,
}

impl CatalogFiles {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn user_dir(&self, user: &str) -> Result<PathBuf, String> {
        if !valid_user(user) {
            return Err("cloud_catalog_invalid_user".into());
        }
        Ok(self.root.join(user))
    }

    /// This user's saved catalog, or `None` when there is none or it cannot be read.
    pub fn load(&self, user: &str) -> Result<Option<Value>, String> {
        let dir = self.user_dir(user)?;
        self.forget_other_users(user);
        let Ok(bytes) = std::fs::read(dir.join(FILE)) else { return Ok(None) };
        if bytes.len() > CATALOG_LIMIT {
            return Ok(None);
        }
        // A torn or foreign file is not an error: the network fills it again.
        Ok(serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object))
    }

    pub fn save(&self, user: &str, catalog: &Value) -> Result<(), String> {
        let dir = self.user_dir(user)?;
        if !catalog.is_object() {
            return Err("cloud_catalog_invalid".into());
        }
        let bytes = serde_json::to_vec(catalog).map_err(|_| "cloud_catalog_invalid".to_string())?;
        if bytes.len() > CATALOG_LIMIT {
            return Err("cloud_catalog_too_large".into());
        }
        crate::store::ensure_dir(self.root.clone()).map_err(|_| "cloud_catalog_unwritable".to_string())?;
        crate::store::ensure_dir(dir.clone()).map_err(|_| "cloud_catalog_unwritable".to_string())?;
        crate::store::write_atomic(&dir.join(FILE), &bytes).map_err(|_| "cloud_catalog_unwritable".to_string())
    }

    /// A different user signed in: nothing an earlier user kept stays on disk.
    fn forget_other_users(&self, user: &str) {
        let Ok(entries) = std::fs::read_dir(&self.root) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name == user || !valid_user(name) || !entry.path().is_dir() {
                continue;
            }
            if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                log::warn!("drop an earlier user's cloud catalog: {error}");
            }
        }
    }
}

// ---------------------------------------------------------------- Tauri

fn files() -> Result<CatalogFiles, String> {
    Ok(CatalogFiles::new(crate::store::root().map_err(|_| "cloud_catalog_unwritable".to_string())?.join("cloud")))
}

/// The signed-in user, if the webview's revision is still the current one.
fn user_for(state: &crate::AppState, revision: &str) -> Result<String, String> {
    match state.account.current_revision() {
        Some((user, current)) if current == revision => Ok(user),
        Some(_) => Err("cloud_catalog_account_changed".into()),
        None => Err("cloud_catalog_signed_out".into()),
    }
}

#[tauri::command]
pub async fn cloud_catalog_load(state: tauri::State<'_, crate::AppState>, revision: String) -> Result<Option<Value>, String> {
    let user = user_for(&state, &revision)?;
    tauri::async_runtime::spawn_blocking(move || files()?.load(&user))
        .await
        .map_err(|_| "cloud_catalog_task_failed".to_string())?
}

#[tauri::command]
pub async fn cloud_catalog_save(state: tauri::State<'_, crate::AppState>, revision: String, catalog: Value) -> Result<(), String> {
    let user = user_for(&state, &revision)?;
    tauri::async_runtime::spawn_blocking(move || files()?.save(&user, &catalog))
        .await
        .map_err(|_| "cloud_catalog_task_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saves_and_loads_one_users_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let files = CatalogFiles::new(dir.path().join("cloud"));
        assert_eq!(files.load("user-1").unwrap(), None);
        let catalog = json!({ "version": 1, "orgs": { "org-a": { "workspaces": [] } } });
        files.save("user-1", &catalog).unwrap();
        assert_eq!(files.load("user-1").unwrap(), Some(catalog));
        assert!(dir.path().join("cloud/user-1/catalog.json").is_file());
    }

    #[test]
    fn a_different_user_signing_in_deletes_what_the_earlier_one_kept() {
        let dir = tempfile::tempdir().unwrap();
        let files = CatalogFiles::new(dir.path().join("cloud"));
        files.save("user-1", &json!({ "version": 1 })).unwrap();
        // The same user again keeps it.
        assert!(files.load("user-1").unwrap().is_some());
        assert_eq!(files.load("user-2").unwrap(), None);
        assert!(!dir.path().join("cloud/user-1").exists());
    }

    #[test]
    fn refuses_paths_and_non_objects() {
        let dir = tempfile::tempdir().unwrap();
        let files = CatalogFiles::new(dir.path().join("cloud"));
        for user in ["", "..", "a/b", "../x", "a b"] {
            assert!(files.save(user, &json!({})).is_err(), "{user:?}");
            assert!(files.load(user).is_err(), "{user:?}");
        }
        assert_eq!(files.save("user-1", &json!([1, 2])).unwrap_err(), "cloud_catalog_invalid");
        let big = json!({ "blob": "x".repeat(CATALOG_LIMIT) });
        assert_eq!(files.save("user-1", &big).unwrap_err(), "cloud_catalog_too_large");
    }

    #[test]
    fn a_torn_file_reads_as_nothing_saved() {
        let dir = tempfile::tempdir().unwrap();
        let files = CatalogFiles::new(dir.path().join("cloud"));
        std::fs::create_dir_all(dir.path().join("cloud/user-1")).unwrap();
        std::fs::write(dir.path().join("cloud/user-1/catalog.json"), b"{\"version\":").unwrap();
        assert_eq!(files.load("user-1").unwrap(), None);
    }
}
