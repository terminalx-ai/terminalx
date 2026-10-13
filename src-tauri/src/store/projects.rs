//! Attached projects: Git checkouts and ordinary folders the reader has opened.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectKind {
    #[default]
    Git,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub kind: ProjectKind,
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
    /// How a session started from an issue is carried on to a pull request, a
    /// review and a merge. Absent is every default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_pipeline: Option<IssuePipelineSettings>,
}

/// The kinds of change a project marks as always needing a person to merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProtectedCategories {
    /// Database migrations and schema files.
    pub migrations: bool,
    /// Production deploy and CI configuration.
    pub deploy: bool,
    /// Anything the reviewer's security pass flagged.
    pub security: bool,
    /// The project's own patterns, in `.gitignore` syntax.
    pub paths: Vec<String>,
}

impl Default for ProtectedCategories {
    fn default() -> Self {
        Self { migrations: true, deploy: true, security: true, paths: Vec::new() }
    }
}

/// A project's issue pipeline. The Rust side reads it when a turn ends and
/// when a merge is decided, with no window open, so it lives here and not in
/// the webview's preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IssuePipelineSettings {
    /// Off leaves a session started from an issue as it always was: the agent
    /// writes code and nothing follows.
    pub enabled: bool,
    /// What "Merge automatically when the review is addressed" starts at for
    /// a new issue session. Each issue has its own switch after that.
    pub auto_merge: bool,
    /// A person presses merge whatever the switch says: for a repository that
    /// deploys from its default branch.
    pub require_person: bool,
    /// How many reviews a pull request gets before it is left to a person.
    #[serde(deserialize_with = "review_rounds")]
    pub max_rounds: u32,
    /// `merge`, `squash` or `rebase`.
    #[serde(deserialize_with = "merge_method")]
    pub merge_method: String,
    pub protected: ProtectedCategories,
    /// Checks that never hold a merge, by a part of their name. Only for
    /// checks branch protection does not require.
    pub ignored_checks: Vec<String>,
}

pub const DEFAULT_REVIEW_ROUNDS: u32 = 3;
pub const MAX_REVIEW_ROUNDS: u32 = 10;

/// A hand-edited round count is kept inside the range the setting offers.
fn review_rounds<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<u32, D::Error> {
    let rounds = serde_json::Value::deserialize(d)?.as_u64().and_then(|value| u32::try_from(value).ok());
    Ok(rounds.filter(|value| (1..=MAX_REVIEW_ROUNDS).contains(value)).unwrap_or(DEFAULT_REVIEW_ROUNDS))
}

fn merge_method<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<String, D::Error> {
    let method = Option::<String>::deserialize(d)?.unwrap_or_default();
    Ok(if matches!(method.as_str(), "merge" | "squash" | "rebase") { method } else { "merge".into() })
}

impl Default for IssuePipelineSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_merge: false,
            require_person: false,
            max_rounds: DEFAULT_REVIEW_ROUNDS,
            merge_method: "merge".into(),
            protected: ProtectedCategories::default(),
            ignored_checks: Vec::new(),
        }
    }
}

/// The pipeline settings of the project at `path`: every default for a
/// project that set none. An error when the store cannot be read or the
/// project is no longer attached, so that the defaults are never taken for
/// the settings of a project that keeps the merge for a person.
pub fn issue_pipeline_settings(path: &str) -> Result<IssuePipelineSettings> {
    let project = load()?.projects.into_iter().find(|p| p.path == path).with_context(|| format!("The project at {path} is no longer attached."))?;
    Ok(project.issue_pipeline.unwrap_or_default())
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
    #[serde(default)]
    pub issue_pipeline: Option<IssuePipelineSettings>,
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
    if let Some(v) = patch.issue_pipeline {
        // Every default is stored as nothing, so a project nobody configured
        // follows the defaults of whichever build reads it.
        p.issue_pipeline = (v != IssuePipelineSettings::default()).then_some(v);
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

/// Validate before persisting projects or choosing a process working directory.
pub fn canonical_directory(path: &str) -> Result<String> {
    let canonical = canonical(path)?;
    anyhow::ensure!(Path::new(&canonical).is_dir(), "Not a directory: {path}");
    Ok(canonical)
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

/// A local mirror of a cloud workspace holds files a remote machine chose
/// (PRO-25). It is for reading: as a project or an agent's working directory
/// it would have agents and tools act on that content, here. `path` is
/// canonical.
pub fn refuse_mirror(path: &str) -> Result<()> {
    #[cfg(feature = "desktop")]
    if crate::cloud_mirror::holds(&super::root()?, Path::new(path)) {
        anyhow::bail!("This folder is a local mirror of a cloud workspace. A mirror is a read-only copy and cannot be opened as a project or used by an agent; work in the cloud workspace, or copy the files somewhere else first.");
    }
    let _ = path;
    Ok(())
}

pub fn add(path: &str) -> Result<Project> {
    let path = canonical_directory(path)?;
    refuse_mirror(&path)?;
    let kind = if crate::git::is_repo(Path::new(&path)) { ProjectKind::Git } else { ProjectKind::Folder };
    let mut f = load()?;
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(existing) = f.projects.iter_mut().find(|p| p.path == path) {
        existing.last_opened = Some(now);
        existing.kind = kind;
        let out = existing.clone();
        f.last_selected = Some(path);
        save(&f)?;
        return Ok(out);
    }
    let p = Project { kind, name: project_name(&path), path: path.clone(), last_opened: Some(now), color: None, mascot: None, logo: None, pinned: false, archived: false, issue_pipeline: None };
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
    fn directories_are_validated_and_git_projects_keep_their_kind() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "hello").unwrap();
        assert!(add(file.to_str().unwrap()).unwrap_err().to_string().contains("Not a directory"));
        assert!(add(dir.path().join("missing").to_str().unwrap()).is_err());
        assert!(list().unwrap().0.is_empty());
        let folder = add(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(folder.kind, ProjectKind::Folder);
        assert!(!dir.path().join(".git").exists());
        assert_eq!(list().unwrap().0, vec![folder]);
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(dir.path()).status().unwrap().success());
        assert_eq!(add(dir.path().to_str().unwrap()).unwrap().kind, ProjectKind::Git);
        assert_eq!(list().unwrap().0.len(), 1);
        let legacy: Project = serde_json::from_str(r#"{"path":"/repo","name":"repo"}"#).unwrap();
        assert_eq!(legacy.kind, ProjectKind::Git);
    }

    #[cfg(unix)]
    #[test]
    fn folder_aliases_do_not_duplicate_projects() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder");
        let alias = dir.path().join("alias");
        std::fs::create_dir(&folder).unwrap();
        std::os::unix::fs::symlink(&folder, &alias).unwrap();
        assert_eq!(add(folder.to_str().unwrap()).unwrap().path, add(alias.to_str().unwrap()).unwrap().path);
        assert_eq!(list().unwrap().0.len(), 1);
    }

    #[test]
    fn issue_pipeline_settings_default_to_no_merge_and_survive_a_damaged_file() {
        let defaults = IssuePipelineSettings::default();
        assert!(defaults.enabled && !defaults.auto_merge && !defaults.require_person);
        assert_eq!((defaults.max_rounds, defaults.merge_method.as_str()), (3, "merge"));
        assert!(defaults.protected.migrations && defaults.protected.deploy && defaults.protected.security);
        // A project written before the pipeline existed.
        let older: Project = serde_json::from_str(r#"{"path":"/repo","name":"repo"}"#).unwrap();
        assert_eq!(older.issue_pipeline, None);
        assert!(!serde_json::to_string(&older).unwrap().contains("issuePipeline"));
        // A partial or hand-edited block: what is readable is kept, the rest is the default.
        let partial: IssuePipelineSettings = serde_json::from_str(r#"{"autoMerge":true,"maxRounds":0,"mergeMethod":"force","protected":{"deploy":false,"paths":["db/"]}}"#).unwrap();
        assert!(partial.auto_merge && partial.enabled);
        assert_eq!((partial.max_rounds, partial.merge_method.as_str()), (3, "merge"));
        assert!(partial.protected.migrations && !partial.protected.deploy);
        assert_eq!(partial.protected.paths, ["db/"]);
        assert_eq!(serde_json::from_str::<IssuePipelineSettings>(r#"{"maxRounds":5,"mergeMethod":"squash"}"#).map(|s| (s.max_rounds, s.merge_method)).unwrap(), (5, "squash".into()));
        assert_eq!(serde_json::from_str::<IssuePipelineSettings>(r#"{"maxRounds":99}"#).unwrap().max_rounds, 3);
    }

    #[test]
    fn a_project_stores_its_issue_pipeline_and_drops_it_when_it_is_all_defaults() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = add(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(issue_pipeline_settings(&project.path).unwrap(), IssuePipelineSettings::default());
        let chosen = IssuePipelineSettings { auto_merge: true, require_person: true, ignored_checks: vec!["windows".into()], ..Default::default() };
        let updated = update(&project.path, ProjectPatch { issue_pipeline: Some(chosen.clone()), ..Default::default() }).unwrap();
        assert_eq!(updated.issue_pipeline, Some(chosen.clone()));
        assert_eq!(issue_pipeline_settings(&project.path).unwrap(), chosen);
        // Another patch leaves it alone.
        update(&project.path, ProjectPatch { pinned: Some(true), ..Default::default() }).unwrap();
        assert_eq!(issue_pipeline_settings(&project.path).unwrap(), chosen);
        let reset = update(&project.path, ProjectPatch { issue_pipeline: Some(IssuePipelineSettings::default()), ..Default::default() }).unwrap();
        assert_eq!(reset.issue_pipeline, None);
        // Settings that cannot be read are an error, never the defaults: a
        // project that has a person merge must not be read as one that does not.
        assert!(issue_pipeline_settings("/not/attached").unwrap_err().to_string().contains("no longer attached"));
        std::fs::write(crate::store::root().unwrap().join("projects.json"), "{broken").unwrap();
        assert!(issue_pipeline_settings(&project.path).is_err());
    }

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
