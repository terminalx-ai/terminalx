//! Settings the Rust side needs before the webview exists. Anything the
//! frontend can read for itself lives in localStorage instead.

use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Where new worktrees go, relative to the project root.
    pub worktree_dir: String,
    /// Branch prefix for session worktrees.
    pub branch_prefix: String,
    /// Extra directories to search for agent binaries.
    pub extra_bin_dirs: Vec<String>,
    pub notifications: bool,
    /// Personal API key for Linear; the file is kept owner-readable only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linear_api_key: Option<String>,
    /// Who the key belonged to when it was saved, for the settings row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linear_viewer: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            worktree_dir: ".raccoon/worktrees".into(),
            branch_prefix: "raccoon/".into(),
            extra_bin_dirs: Vec::new(),
            notifications: true,
            linear_api_key: None,
            linear_viewer: None,
        }
    }
}

fn file_path() -> Result<PathBuf> {
    Ok(super::root()?.join("settings.json"))
}

pub fn load() -> Settings {
    file_path()
        .ok()
        .and_then(|p| super::read_json::<Settings>(&p).ok().flatten())
        .unwrap_or_default()
}

pub fn save(s: &Settings) -> Result<()> {
    let path = file_path()?;
    super::write_json(&path, s)?;
    // The file can hold a tracker API key, so nobody else on the machine reads it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
