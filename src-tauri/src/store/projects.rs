//! Attached projects: Git checkouts and ordinary folders the reader has opened.

use std::collections::BTreeMap;
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
    /// `terminalx issues` may comment on the issues of this project's GitHub
    /// repository and move their status without the person being asked each
    /// time. Assigning, labelling, creating and Linear issues still ask. Off
    /// by default.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub agent_issue_updates: bool,
    /// What the reader calls a branch in the sidebar, by branch name. A
    /// branch with none goes by its own name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub branch_labels: BTreeMap<String, String>,
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
    /// The project's own choice for what "Merge when green" starts at in a new
    /// session, for every session. `None` until one is made: then a session
    /// started from an issue starts with it on and any other with it off
    /// (`auto_merge_at_start`). Each pipeline has its own switch after that.
    /// Never written as `null`, which an older runtime could not read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_merge: Option<bool>,
    /// The same for "Resolve conflicts automatically" (`resolve_conflicts_at_start`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolve_conflicts: Option<bool>,
    #[serde(deserialize_with = "review_rounds")]
    pub max_resolutions: u32,
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
    /// Explicit opt-in for repositories without CI. Never overrides reported
    /// checks, pending workflows/suites, required checks or unreadable evidence.
    pub allow_no_ci: bool,
    pub local_check_command: Option<String>,
    pub local_checks_only: bool,
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
            auto_merge: None,
            resolve_conflicts: None,
            max_resolutions: 3,
            require_person: false,
            max_rounds: DEFAULT_REVIEW_ROUNDS,
            merge_method: "merge".into(),
            protected: ProtectedCategories::default(),
            ignored_checks: Vec::new(),
            allow_no_ci: false,
            local_check_command: None,
            local_checks_only: false,
        }
    }
}

impl IssuePipelineSettings {
    /// What "Merge when green" starts at for a new session that nobody chose
    /// it for: the project's choice, else on for a session started from an
    /// issue (#700) and off for any other. Never on where a person does the
    /// merge. A cloud workspace, which never merges, is the caller's to rule out.
    pub fn auto_merge_at_start(&self, from_issue: bool) -> bool {
        !self.require_person && self.auto_merge.unwrap_or(from_issue)
    }

    /// What "Resolve conflicts automatically" starts at, as `auto_merge_at_start`.
    pub fn resolve_conflicts_at_start(&self, from_issue: bool) -> bool {
        self.resolve_conflicts.unwrap_or(from_issue)
    }

    /// Before #700 every save wrote both switches, `false` unless turned on,
    /// so a stored `false` from then is no choice: read it as none made.
    fn forget_unchosen_switches(&mut self) {
        if self.auto_merge == Some(false) { self.auto_merge = None; }
        if self.resolve_conflicts == Some(false) { self.resolve_conflicts = None; }
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
    #[serde(default)]
    pub agent_issue_updates: Option<bool>,
    #[serde(default)]
    pub branch_label: Option<BranchLabel>,
}

/// One branch's sidebar label; none, or a blank one, clears it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchLabel {
    pub branch: String,
    #[serde(default)]
    pub label: Option<String>,
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
    if let Some(v) = patch.agent_issue_updates {
        p.agent_issue_updates = v;
    }
    if let Some(BranchLabel { branch, label }) = patch.branch_label {
        match label.map(|label| label.trim().to_string()).filter(|label| !label.is_empty() && *label != branch) {
            Some(label) => p.branch_labels.insert(branch, label),
            None => p.branch_labels.remove(&branch),
        };
    }
    let out = p.clone();
    save(&f)?;
    Ok(out)
}

/// A branch renamed in git keeps its sidebar label under its new name.
pub fn move_branch_label(path: &str, from: &str, to: &str) -> Result<Project> {
    let mut f = load()?;
    let p = f.projects.iter_mut().find(|p| p.path == path).with_context(|| format!("project {path} is not attached"))?;
    if let Some(label) = p.branch_labels.remove(from) {
        if label != to {
            p.branch_labels.insert(to.to_string(), label);
        }
    }
    let out = p.clone();
    save(&f)?;
    Ok(out)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectsFile {
    #[serde(default)]
    projects: Vec<Project>,
    #[serde(default)]
    last_selected: Option<String>,
}

/// 1: an issue pipeline's switches are stored only once chosen (#700).
const PROJECTS_VERSION: u32 = 1;

fn file_path() -> Result<PathBuf> {
    Ok(super::root()?.join("projects.json"))
}

/// How far `projects.json` has been migrated, kept in a file of its own. A
/// build from before #700 rewrites `projects.json` whole on any save, dropping
/// fields it does not know and writing both switches as `false`, but never
/// touches this file: what such a build writes afterwards reads as Off, which
/// never merges by itself, and not as no choice.
fn migrations_path() -> Result<PathBuf> {
    Ok(super::root()?.join("projects-migrations.json"))
}

/// A marker that cannot be read counts as current: migrating again would
/// forget an Off chosen since.
fn migrated_version() -> Result<u32> {
    let path = migrations_path()?;
    Ok(match super::read_json::<serde_json::Value>(&path) {
        Ok(None) => 0,
        Ok(Some(marker)) => marker["version"].as_u64().map_or(PROJECTS_VERSION, |version| u32::try_from(version).unwrap_or(u32::MAX)),
        Err(error) => {
            log::warn!("read {}: {error:#}", path.display());
            PROJECTS_VERSION
        }
    })
}

fn load() -> Result<ProjectsFile> {
    let f: ProjectsFile = super::read_json(&file_path()?)?.unwrap_or_default();
    if migrated_version()? >= PROJECTS_VERSION {
        return Ok(f);
    }
    Ok(migrate(f))
}

/// Forget the switches a build from before #700 saved as `false`, once, and
/// answer with the file as it then stands on disk. The marker is written
/// first: should the file then fail to be written, its `false`s stay and read
/// as Off. Should the marker fail, nothing is forgotten until it can be written.
fn migrate(f: ProjectsFile) -> ProjectsFile {
    let mut migrated = f.clone();
    for project in &mut migrated.projects {
        if let Some(settings) = project.issue_pipeline.as_mut() {
            settings.forget_unchosen_switches();
        }
        // As `update` keeps it: every default is stored as nothing.
        if project.issue_pipeline.as_ref() == Some(&IssuePipelineSettings::default()) {
            project.issue_pipeline = None;
        }
    }
    if let Err(error) = migrations_path().and_then(|path| super::write_json(&path, &serde_json::json!({ "version": PROJECTS_VERSION }))) {
        log::warn!("mark projects.json migrated: {error:#}");
        return f;
    }
    if migrated.projects == f.projects {
        return migrated;
    }
    match save(&migrated) {
        Ok(()) => migrated,
        Err(error) => {
            log::warn!("migrate projects.json: {error:#}");
            f
        }
    }
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

/// What a paired phone calls a project: stable for its path, without saying
/// the path, which never leaves this Mac.
pub fn public_id(path: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("terminalx-project:{path}").as_bytes());
    digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

/// The project a paired phone named by its [`public_id`]. Archived projects
/// are not offered, so they cannot be named.
pub fn by_public_id(id: &str) -> Result<Project> {
    list()?.0.into_iter().find(|project| !project.archived && public_id(&project.path) == id)
        .context("That project is no longer on this Mac.")
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
    let p = Project { kind, name: project_name(&path), path: path.clone(), last_opened: Some(now), color: None, mascot: None, logo: None, pinned: false, archived: false, issue_pipeline: None, agent_issue_updates: false, branch_labels: BTreeMap::new() };
    f.projects.push(p.clone());
    f.last_selected = Some(path);
    save(&f)?;
    Ok(p)
}

/// Register a folder as a project if it is not one yet, without making it the
/// selected project: for projects the app finds rather than ones the reader adds.
pub fn ensure(path: &str) -> Result<Project> {
    ensure_as(path, None)
}

/// Register a folder as a plain folder project, whatever git says about it:
/// for a folder inside a repository that does not really own it (a `git init`
/// run in Documents or the home folder by mistake).
pub fn ensure_folder(path: &str) -> Result<Project> {
    ensure_as(path, Some(ProjectKind::Folder))
}

fn ensure_as(path: &str, kind: Option<ProjectKind>) -> Result<Project> {
    let path = canonical_directory(path)?;
    refuse_mirror(&path)?;
    let mut f = load()?;
    if let Some(existing) = f.projects.iter().find(|p| p.path == path) {
        return Ok(existing.clone());
    }
    let kind = kind.unwrap_or(if crate::git::is_repo(Path::new(&path)) { ProjectKind::Git } else { ProjectKind::Folder });
    let p = Project { kind, name: project_name(&path), path: path.clone(), last_opened: Some(chrono::Utc::now().to_rfc3339()), color: None, mascot: None, logo: None, pinned: false, archived: false, issue_pipeline: None, agent_issue_updates: false, branch_labels: BTreeMap::new() };
    f.projects.push(p.clone());
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
        assert!(defaults.enabled && defaults.auto_merge.is_none() && defaults.resolve_conflicts.is_none() && !defaults.require_person);
        // Nothing chosen and nothing written: an older runtime reads it as off.
        assert!(!serde_json::to_string(&defaults).unwrap().contains("autoMerge"));
        assert!(!serde_json::to_string(&defaults).unwrap().contains("resolveConflicts"));
        assert_eq!((defaults.max_rounds, defaults.merge_method.as_str()), (3, "merge"));
        assert!(defaults.protected.migrations && defaults.protected.deploy && defaults.protected.security);
        // A project written before the pipeline existed.
        let older: Project = serde_json::from_str(r#"{"path":"/repo","name":"repo"}"#).unwrap();
        assert_eq!(older.issue_pipeline, None);
        assert!(!serde_json::to_string(&older).unwrap().contains("issuePipeline"));
        // A partial or hand-edited block: what is readable is kept, the rest is the default.
        let partial: IssuePipelineSettings = serde_json::from_str(r#"{"autoMerge":true,"maxRounds":0,"mergeMethod":"force","protected":{"deploy":false,"paths":["db/"]}}"#).unwrap();
        assert!(partial.auto_merge == Some(true) && partial.resolve_conflicts.is_none() && partial.enabled);
        assert!(!partial.allow_no_ci);
        assert!(serde_json::from_str::<IssuePipelineSettings>(r#"{"allowNoCi":true}"#).unwrap().allow_no_ci);
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
        let chosen = IssuePipelineSettings { auto_merge: Some(true), require_person: true, ignored_checks: vec!["windows".into()], ..Default::default() };
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
    fn a_session_from_an_issue_starts_with_both_switches_on_unless_the_project_chose_otherwise() {
        let unset = IssuePipelineSettings::default();
        assert!(unset.auto_merge_at_start(true) && unset.resolve_conflicts_at_start(true));
        // Any other session is as it was: off until the project turns a switch on.
        assert!(!unset.auto_merge_at_start(false) && !unset.resolve_conflicts_at_start(false));
        let off = IssuePipelineSettings { auto_merge: Some(false), resolve_conflicts: Some(false), ..Default::default() };
        assert!(!off.auto_merge_at_start(true) && !off.resolve_conflicts_at_start(true));
        let on = IssuePipelineSettings { auto_merge: Some(true), resolve_conflicts: Some(true), ..Default::default() };
        assert!(on.auto_merge_at_start(false) && on.resolve_conflicts_at_start(false));
        // A person does the merge: no session starts set to merge, whatever was chosen.
        let person = IssuePipelineSettings { require_person: true, ..on };
        assert!(!person.auto_merge_at_start(true) && !person.auto_merge_at_start(false));
        assert!(person.resolve_conflicts_at_start(true));
    }

    #[test]
    fn a_switch_saved_off_before_it_was_a_choice_reads_as_unchosen_once() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let (busy, idle, merging) = (dir.path().join("busy"), dir.path().join("idle"), dir.path().join("merging"));
        for path in [&busy, &idle, &merging] {
            std::fs::create_dir(path).unwrap();
        }
        let path = |dir: &std::path::Path| canonical(dir.to_str().unwrap()).unwrap();
        // As an older build saved them: every field, the switches `false` unless turned on.
        let legacy = |auto_merge: bool, max_rounds: u32| serde_json::json!({
            "enabled": true, "autoMerge": auto_merge, "resolveConflicts": false, "maxResolutions": 3, "requirePerson": false,
            "maxRounds": max_rounds, "mergeMethod": "merge", "protected": {"migrations": true, "deploy": true, "security": true, "paths": []},
            "ignoredChecks": [], "allowNoCi": false, "localCheckCommand": null, "localChecksOnly": false,
        });
        let file = serde_json::json!({"projects": [
            {"path": path(&busy), "name": "busy", "issuePipeline": legacy(false, 5)},
            {"path": path(&idle), "name": "idle", "issuePipeline": legacy(false, 3)},
            {"path": path(&merging), "name": "merging", "issuePipeline": legacy(true, 3)},
        ]});
        std::fs::write(file_path().unwrap(), serde_json::to_string(&file).unwrap()).unwrap();

        // What else was set stays; the off switches become no choice; one turned on stays on.
        let kept = issue_pipeline_settings(&path(&busy)).unwrap();
        assert_eq!((kept.auto_merge, kept.resolve_conflicts, kept.max_rounds), (None, None, 5));
        assert_eq!(list().unwrap().0.iter().find(|p| p.name == "idle").unwrap().issue_pipeline, None);
        assert_eq!(issue_pipeline_settings(&path(&merging)).unwrap().auto_merge, Some(true));
        // Done on disk at once, and marked done beside the file rather than in it.
        let on_disk = std::fs::read_to_string(file_path().unwrap()).unwrap();
        assert!(!on_disk.contains("\"autoMerge\": false") && !on_disk.contains("\"resolveConflicts\": false"), "{on_disk}");
        assert!(!on_disk.contains("version"));
        let marker: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(migrations_path().unwrap()).unwrap()).unwrap();
        assert_eq!(marker["version"], PROJECTS_VERSION);

        // A choice made since is kept.
        let off = IssuePipelineSettings { auto_merge: Some(false), resolve_conflicts: Some(false), ..kept };
        update(&path(&busy), ProjectPatch { issue_pipeline: Some(off.clone()), ..Default::default() }).unwrap();
        assert_eq!(issue_pipeline_settings(&path(&busy)).unwrap(), off);
        assert!(!issue_pipeline_settings(&path(&busy)).unwrap().auto_merge_at_start(true));

        // An older build saving afterwards (selecting a project is enough) writes
        // the file whole again, both switches `false` and no marker of its own:
        // that reads as Off, which never merges by itself, not as no choice.
        std::fs::write(file_path().unwrap(), serde_json::to_string(&file).unwrap()).unwrap();
        let rewritten = issue_pipeline_settings(&path(&busy)).unwrap();
        assert_eq!((rewritten.auto_merge, rewritten.resolve_conflicts), (Some(false), Some(false)));
        assert!(!rewritten.auto_merge_at_start(true) && !rewritten.resolve_conflicts_at_start(true));

        // A marker that cannot be read is no reason to migrate again.
        std::fs::write(migrations_path().unwrap(), "{broken").unwrap();
        assert_eq!(issue_pipeline_settings(&path(&idle)).unwrap().auto_merge, Some(false));
    }

    #[test]
    fn a_new_store_is_marked_migrated_and_never_forgets_a_choice() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = add(dir.path().to_str().unwrap()).unwrap();
        assert!(migrations_path().unwrap().exists());
        let off = IssuePipelineSettings { auto_merge: Some(false), ..Default::default() };
        update(&project.path, ProjectPatch { issue_pipeline: Some(off.clone()), ..Default::default() }).unwrap();
        assert_eq!(issue_pipeline_settings(&project.path).unwrap(), off);
    }

    #[test]
    fn a_branch_keeps_its_label_until_cleared_and_through_a_rename() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = add(dir.path().to_str().unwrap()).unwrap();
        let label = |branch: &str, label: Option<&str>| ProjectPatch { branch_label: Some(BranchLabel { branch: branch.into(), label: label.map(Into::into) }), ..Default::default() };
        let labelled = update(&project.path, label("dc/calm-ember", Some("  Pricing research "))).unwrap();
        assert_eq!(labelled.branch_labels.get("dc/calm-ember").map(String::as_str), Some("Pricing research"));
        // Another patch leaves it alone.
        assert_eq!(update(&project.path, ProjectPatch { pinned: Some(true), ..Default::default() }).unwrap().branch_labels.len(), 1);
        let moved = move_branch_label(&project.path, "dc/calm-ember", "dc/pricing").unwrap();
        assert_eq!(moved.branch_labels.into_iter().collect::<Vec<_>>(), [("dc/pricing".to_string(), "Pricing research".to_string())]);
        // A blank label, or the branch's own name, is no label.
        assert!(update(&project.path, label("dc/pricing", Some(" "))).unwrap().branch_labels.is_empty());
        assert!(update(&project.path, label("dc/pricing", Some("dc/pricing"))).unwrap().branch_labels.is_empty());
        assert!(!serde_json::to_string(&project).unwrap().contains("branchLabels"));
    }

    #[test]
    fn agents_ask_before_updating_issues_until_the_project_says_otherwise() {
        let _home = crate::store::temp_home();
        let older: Project = serde_json::from_str(r#"{"path":"/repo","name":"repo"}"#).unwrap();
        assert!(!older.agent_issue_updates);
        assert!(!serde_json::to_string(&older).unwrap().contains("agentIssueUpdates"));
        let dir = tempfile::tempdir().unwrap();
        let project = add(dir.path().to_str().unwrap()).unwrap();
        assert!(!project.agent_issue_updates);
        let allowed = update(&project.path, ProjectPatch { agent_issue_updates: Some(true), ..Default::default() }).unwrap();
        assert!(allowed.agent_issue_updates);
        assert!(serde_json::to_string(&allowed).unwrap().contains(r#""agentIssueUpdates":true"#));
        // Another patch leaves it alone.
        assert!(update(&project.path, ProjectPatch { pinned: Some(true), ..Default::default() }).unwrap().agent_issue_updates);
        assert!(!update(&project.path, ProjectPatch { agent_issue_updates: Some(false), ..Default::default() }).unwrap().agent_issue_updates);
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
