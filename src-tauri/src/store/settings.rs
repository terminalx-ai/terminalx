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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            worktree_dir: ".raccoon/worktrees".into(),
            branch_prefix: "raccoon/".into(),
            extra_bin_dirs: Vec::new(),
            notifications: true,
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
    super::write_json(&file_path()?, s)
}
