//! Build output a workspace can free: the folders that a build or an install
//! makes again, offered for the Trash from the Files tab.
//!
//! Nothing useful is ever in the offer. A folder is offered only when every
//! one of these holds:
//!
//! - git ignores it, so it is in no commit and on no branch (`git ls-files
//!   --others --ignored --directory`: the whole folder is ignored, nothing in
//!   it tracked);
//! - its name is on [`FOLDERS`], an allowlist of folders tools rebuild
//!   (`node_modules`, `dist`, `.next`…), or it is a `target` beside a
//!   `Cargo.toml`. A big ignored folder with any other name is never offered:
//!   it could be someone's data;
//! - it is a real folder, not a link to somewhere else;
//! - nothing in its top level looks like a secret or local settings
//!   (`.env*`, keys, `.npmrc`), a second guard on top of the name.
//!
//! New files that are not committed, and ignored files that are not in such
//! a folder (`.env`, `.env.local`, an editor's settings), are never offered.
//! Freeing scans again first and moves only what that fresh scan still
//! offers, to the Trash, so a change in between is respected and a mistake
//! can be put back.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Folders that tools make again on the next build or install. Ignored by git
/// and named one of these, a folder holds nothing a person wrote.
pub const FOLDERS: &[&str] = &[
    "node_modules",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".vite",
    ".expo",
    ".output",
    ".angular",
    ".docusaurus",
    "dist",
    "build",
    "coverage",
    ".nyc_output",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".gradle",
    "DerivedData",
];

/// One folder that can go.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Rebuildable {
    /// Relative to the workspace, with `/` between parts.
    pub path: String,
    pub bytes: u64,
    pub files: u64,
}

/// What a workspace can free, largest first.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RebuildableScan {
    pub folders: Vec<Rebuildable>,
    pub bytes: u64,
    pub files: u64,
}

/// What freeing did.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Freed {
    pub bytes: u64,
    pub moved: Vec<String>,
    /// Asked for but no longer offered by the fresh scan, or not movable.
    pub skipped: Vec<String>,
}

/// Whether a folder's name is one tools rebuild. `target` only beside a `Cargo.toml`.
fn rebuilt(workspace: &Path, rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if FOLDERS.contains(&name) {
        return true;
    }
    if name == "target" {
        let parent = Path::new(rel).parent().map(|p| workspace.join(p)).unwrap_or_else(|| workspace.to_path_buf());
        return parent.join("Cargo.toml").is_file();
    }
    false
}

/// A name that is a secret or a person's local settings.
fn secret_like(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(".env")
        || lower == ".npmrc"
        || lower == ".netrc"
        || lower == ".pypirc"
        || lower.starts_with("id_rsa")
        || lower.starts_with("id_ed25519")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
}

/// A real folder whose top level holds nothing secret-like.
fn safe_folder(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else { return false };
    !entries.flatten().any(|entry| secret_like(&entry.file_name().to_string_lossy()))
}

/// Bytes and files under a folder, without following links.
fn measure(path: &Path) -> (u64, u64) {
    let (mut bytes, mut files) = (0u64, 0u64);
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                bytes += meta.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// The workspace must be the project itself or one of its git worktrees.
fn known_workspace(project: &Path, workspace: &Path) -> Result<PathBuf> {
    let target = std::fs::canonicalize(workspace)?;
    let known = crate::git::list_worktrees(project)?.into_iter().any(|(worktree, _)| std::fs::canonicalize(worktree).is_ok_and(|p| p == target));
    if !known {
        bail!("{} is not a workspace of this project", workspace.display());
    }
    Ok(target)
}

/// What a workspace can free.
pub fn scan(project: &Path, workspace: &Path) -> Result<RebuildableScan> {
    let root = known_workspace(project, workspace)?;
    let listed = crate::git::run(&root, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])?;
    let mut folders: Vec<Rebuildable> = listed
        .split('\0')
        // Only whole folders: git names one it ignores entirely with a trailing slash.
        .filter_map(|entry| entry.strip_suffix('/'))
        .filter(|rel| !rel.is_empty() && !rel.split('/').any(|part| part == ".." || part == ".git"))
        .filter(|rel| rebuilt(&root, rel))
        .filter(|rel| safe_folder(&root.join(rel)))
        .map(|rel| {
            let (bytes, files) = measure(&root.join(rel));
            Rebuildable { path: rel.to_string(), bytes, files }
        })
        .filter(|folder| folder.files > 0)
        .collect();
    folders.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    let bytes = folders.iter().map(|f| f.bytes).sum();
    let files = folders.iter().map(|f| f.files).sum();
    Ok(RebuildableScan { folders, bytes, files })
}

/// The person's Trash folder.
fn trash_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home folder")?;
    let dir = if cfg!(target_os = "macos") { home.join(".Trash") } else { home.join(".local/share/Trash/files") };
    if cfg!(target_os = "windows") {
        bail!("Moving to the Recycle Bin is not supported here yet.");
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Move the asked-for folders to the Trash: only those a fresh scan still offers.
pub fn free(project: &Path, workspace: &Path, asked: &[String]) -> Result<Freed> {
    let fresh = scan(project, workspace)?;
    let root = known_workspace(project, workspace)?;
    let trash = trash_dir()?;
    let label = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M.%S");
    let mut freed = Freed::default();
    for rel in asked {
        let Some(folder) = fresh.folders.iter().find(|f| &f.path == rel) else {
            freed.skipped.push(rel.clone());
            continue;
        };
        let from = root.join(&folder.path);
        let name = folder.path.replace('/', " › ");
        let to = trash.join(format!("{name} ({label} {stamp})"));
        // A rename: instant, and the folder can be put back from the Trash. Another disk cannot take one.
        match std::fs::rename(&from, &to) {
            Ok(()) => {
                freed.bytes += folder.bytes;
                freed.moved.push(folder.path.clone());
            }
            Err(_) => freed.skipped.push(rel.clone()),
        }
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_only_rebuilt_folder_names() {
        let dir = tempfile::tempdir().unwrap();
        assert!(rebuilt(dir.path(), "node_modules"));
        assert!(rebuilt(dir.path(), "apps/web/.next"));
        assert!(!rebuilt(dir.path(), "data"));
        assert!(!rebuilt(dir.path(), ".env"));
        assert!(!rebuilt(dir.path(), "target"));
        std::fs::write(dir.path().join("Cargo.toml"), "").unwrap();
        assert!(rebuilt(dir.path(), "target"));
    }

    #[test]
    fn never_offers_a_folder_holding_a_secret() {
        let dir = tempfile::tempdir().unwrap();
        let build = dir.path().join("build");
        std::fs::create_dir(&build).unwrap();
        std::fs::write(build.join("app.js"), "x").unwrap();
        assert!(safe_folder(&build));
        std::fs::write(build.join(".env.production"), "KEY=1").unwrap();
        assert!(!safe_folder(&build));
        assert!(secret_like("server.pem") && secret_like(".npmrc") && !secret_like("index.js"));
    }
}
