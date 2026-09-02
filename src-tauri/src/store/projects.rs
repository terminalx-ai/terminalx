//! Attached projects: repo roots the reader has opened.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub last_opened: Option<String>,
    /// Accent for the mascot and badges; a token name like `blue`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Pixel mascot id; the folder icon when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mascot: Option<String>,
    /// Absolute path of an image the reader chose instead of a mascot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
}

/// Fields a reader can change from the project menu. `Some(None)` clears.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub mascot: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub logo: Option<Option<String>>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
}

fn double_option<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

pub fn update(path: &str, patch: ProjectPatch) -> Result<Project> {
    let mut f = load()?;
    let p = f.projects.iter_mut().find(|p| p.path == path).with_context(|| format!("project {path} is not attached"))?;
    if let Some(n) = patch.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        p.name = n;
    }
    if let Some(c) = patch.color {
        p.color = c;
    }
    if let Some(m) = patch.mascot {
        p.mascot = m;
    }
    if let Some(l) = patch.logo {
        p.logo = l;
    }
    if let Some(v) = patch.pinned {
        p.pinned = v;
    }
    if let Some(v) = patch.archived {
        p.archived = v;
    }
    let out = p.clone();
    save(&f)?;
    Ok(out)
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectsFile {
    #[serde(default)]
    projects: Vec<Project>,
    #[serde(default)]
    last_selected: Option<String>,
}

fn file_path() -> Result<PathBuf> {
    Ok(super::root()?.join("projects.json"))
}

fn load() -> Result<ProjectsFile> {
    Ok(super::read_json(&file_path()?)?.unwrap_or_default())
}

fn save(f: &ProjectsFile) -> Result<()> {
    super::write_json(&file_path()?, f)
}

/// Canonical form of a project path. `/x/proj` and `/x/proj/` must be one
/// project or the sidebar splits one repo into two groups.
pub fn canonical(path: &str) -> Result<String> {
    let p = Path::new(path);
    let c = std::fs::canonicalize(p).with_context(|| format!("resolve {path}"))?;
    Ok(c.to_string_lossy().into_owned())
}

pub fn project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

pub fn list() -> Result<(Vec<Project>, Option<String>)> {
    let f = load()?;
    Ok((f.projects, f.last_selected))
}

pub fn add(path: &str) -> Result<Project> {
    let path = canonical(path)?;
    let mut f = load()?;
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(existing) = f.projects.iter_mut().find(|p| p.path == path) {
        existing.last_opened = Some(now);
        let out = existing.clone();
        f.last_selected = Some(path);
        save(&f)?;
        return Ok(out);
    }
    let p = Project { name: project_name(&path), path: path.clone(), last_opened: Some(now), color: None, mascot: None, logo: None, pinned: false, archived: false };
    f.projects.push(p.clone());
    f.last_selected = Some(path);
    save(&f)?;
    Ok(p)
}

pub fn remove(path: &str) -> Result<()> {
    let mut f = load()?;
    f.projects.retain(|p| p.path != path);
    if f.last_selected.as_deref() == Some(path) {
        f.last_selected = f.projects.first().map(|p| p.path.clone());
    }
    save(&f)
}

pub fn set_last_selected(path: &str) -> Result<()> {
    let mut f = load()?;
    f.last_selected = Some(path.to_string());
    save(&f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_is_idempotent_on_canonical_path() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let with_slash = format!("{}/", dir.path().display());
        let a = add(dir.path().to_str().unwrap()).unwrap();
        let b = add(&with_slash).unwrap();
        assert_eq!(a.path, b.path);
        let (all, last) = list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(last.as_deref(), Some(a.path.as_str()));
        remove(&a.path).unwrap();
        assert!(list().unwrap().0.is_empty());
    }
}
