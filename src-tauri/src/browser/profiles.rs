//! Browser profiles: each one a separate persistent Chromium user-data
//! directory, and therefore its own cookies, logins and downloads. The
//! `default` profile always exists; named ones are created on demand.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{BrowserError, BrowserResult};

pub const DEFAULT_PROFILE_ID: &str = "default";
pub const PROFILE_ID_MAX_LEN: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: String,
    pub label: String,
    pub created: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Persisted {
    profiles: Vec<BrowserProfile>,
}

pub struct ProfileStore {
    root: PathBuf,
    file: PathBuf,
    profiles: Mutex<Vec<BrowserProfile>>,
}

/// `terminalx-<profile>`: the agent-browser session name for a profile.
pub fn session_name(profile_id: &str) -> String {
    format!("{}{profile_id}", super::sweep::SESSION_PREFIX)
}

/// Lower-case letters, digits and hyphens, starting with a letter or digit,
/// short enough to fit a socket path.
pub fn validate_id(id: &str) -> BrowserResult<()> {
    let ok = !id.is_empty()
        && id.len() <= PROFILE_ID_MAX_LEN
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
        && !id.ends_with('-');
    if ok {
        Ok(())
    } else {
        Err(BrowserError::new(
            "invalid_arguments",
            format!("Profile id {id:?} must be 1–{PROFILE_ID_MAX_LEN} lower-case letters, digits or hyphens."),
        ))
    }
}

pub fn slugify(label: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for c in label.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= PROFILE_ID_MAX_LEN {
            break;
        }
    }
    let trimmed = out.trim_end_matches('-').to_string();
    if trimmed.is_empty() {
        "profile".into()
    } else {
        trimmed
    }
}

impl ProfileStore {
    /// `root` is the app's browser directory; profiles live at
    /// `root/profiles/<id>` and the registry at `root/profiles.json`.
    pub fn open(root: PathBuf) -> anyhow::Result<Self> {
        let file = root.join("profiles.json");
        let persisted: Persisted = crate::store::read_json(&file)?.unwrap_or_default();
        Ok(Self { root, file, profiles: Mutex::new(persisted.profiles) })
    }

    pub fn data_dir(&self, id: &str) -> PathBuf {
        self.root.join("profiles").join(id)
    }

    pub fn download_dir(&self, id: &str) -> PathBuf {
        self.root.join("downloads").join(id)
    }

    fn default_profile() -> BrowserProfile {
        BrowserProfile { id: DEFAULT_PROFILE_ID.into(), label: "Default".into(), created: String::new() }
    }

    pub fn list(&self) -> Vec<BrowserProfile> {
        let mut out = vec![Self::default_profile()];
        out.extend(self.profiles.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned());
        out
    }

    pub fn get(&self, id: &str) -> BrowserResult<BrowserProfile> {
        self.list()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| BrowserError::new("browser_profile_not_found", format!("No browser profile {id}.")))
    }

    pub fn create(&self, label: &str, id: Option<&str>) -> BrowserResult<BrowserProfile> {
        let label = label.trim();
        if label.is_empty() {
            return Err(BrowserError::new("invalid_arguments", "--label cannot be empty."));
        }
        let id = id.map(str::to_string).unwrap_or_else(|| slugify(label));
        validate_id(&id)?;
        if id == DEFAULT_PROFILE_ID || self.get(&id).is_ok() {
            return Err(BrowserError::new("invalid_arguments", format!("A browser profile {id} already exists.")));
        }
        let profile = BrowserProfile { id, label: label.to_string(), created: crate::store::index::now() };
        {
            let mut profiles = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
            profiles.push(profile.clone());
            self.persist(&profiles)?;
        }
        crate::store::ensure_dir(self.data_dir(&profile.id)).map_err(|e| BrowserError::new("browser_error", format!("{e:#}")))?;
        Ok(profile)
    }

    /// Remove the registry entry and the user-data directory. The caller has
    /// already closed the profile's session and pages.
    pub fn delete(&self, id: &str) -> BrowserResult<BrowserProfile> {
        if id == DEFAULT_PROFILE_ID {
            return Err(BrowserError::new("invalid_arguments", "The default browser profile cannot be deleted."));
        }
        let profile = self.get(id)?;
        {
            let mut profiles = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
            profiles.retain(|p| p.id != id);
            self.persist(&profiles)?;
        }
        let dir = self.data_dir(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| BrowserError::new("browser_error", format!("remove {}: {e}", dir.display())))?;
        }
        Ok(profile)
    }

    fn persist(&self, profiles: &[BrowserProfile]) -> BrowserResult<()> {
        crate::store::write_json(&self.file, &Persisted { profiles: profiles.to_vec() })
            .map_err(|e| BrowserError::new("browser_error", format!("{e:#}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_names_carry_the_sweep_prefix_and_fit_a_socket_path() {
        assert_eq!(session_name("default"), "terminalx-default");
        assert!(session_name("default").starts_with(super::super::sweep::SESSION_PREFIX));
        assert!(validate_id("work-account").is_ok());
        assert!(validate_id("Work").is_err());
        assert!(validate_id("-x").is_err());
        assert!(validate_id(&"a".repeat(PROFILE_ID_MAX_LEN + 1)).is_err());
        assert_eq!(slugify("My Work Account!"), "my-work-account");
        assert_eq!(slugify("***"), "profile");
    }

    #[test]
    fn default_profile_is_implicit_and_named_ones_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(tmp.path().to_path_buf()).unwrap();
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.get("default").unwrap().label, "Default");
        let created = store.create("Work Account", None).unwrap();
        assert_eq!(created.id, "work-account");
        assert!(store.data_dir("work-account").is_dir());
        assert!(store.create("Work Account", None).is_err());
        assert!(store.delete("default").is_err());

        let reopened = ProfileStore::open(tmp.path().to_path_buf()).unwrap();
        assert_eq!(reopened.list().len(), 2);
        reopened.delete("work-account").unwrap();
        assert!(!reopened.data_dir("work-account").exists());
        assert!(reopened.get("work-account").is_err());
    }
}
