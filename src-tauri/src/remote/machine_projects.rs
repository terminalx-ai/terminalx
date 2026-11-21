//! `machine/6` (PRO-351, docs/MACHINES.md "As built (PRO-351)"): a
//! machine's projects from another computer.
//!
//! - [`browse`] lists folder names under the home directory of the user the
//!   runtime runs as, never a file's contents. The only files read are a
//!   repository's own `HEAD` and `config` (and the `.git` file of a worktree
//!   or submodule that points at them), for its branch and whether `origin`
//!   is on GitHub.
//! - [`add`] and [`remove`] change the machine's store; the caller emits
//!   `projects_changed`, which brings `machine.changed` to every computer.
//! - [`Clones`] runs `project_start::clone_repository` off the call and keeps
//!   each clone's status for [`FINISHED_KEPT_FOR`] after it ends.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::machine;
use super::protocol::RpcError;
use crate::project_start::{self, Failure};
use crate::sink::EventSink;

/// The most folders one `machine.browse` reply lists, so it fits a relay frame.
pub const MAX_ENTRIES: usize = 500;

/// How long a finished clone's status stays readable (`machine.cloneStatus`).
pub const FINISHED_KEPT_FOR: Duration = Duration::from_secs(10 * 60);

/// The home directory of the user this runtime runs as, canonical.
pub fn home() -> Result<PathBuf, RpcError> {
    let home = dirs::home_dir().ok_or_else(|| RpcError::internal("this runtime's user has no home directory"))?;
    crate::paths::canonicalize(&home).map_err(|error| RpcError::internal(format!("resolve {}: {error}", home.display())))
}

/// A folder a call names, by the rules of `machine.browse`: absolute, and
/// once resolved (symbolic links followed) a folder under `home`. `None`
/// is `home` itself. `home` is canonical.
pub fn resolve_folder(home: &Path, path: Option<&str>) -> Result<PathBuf, RpcError> {
    let Some(path) = path else { return Ok(home.to_path_buf()) };
    if path.is_empty() || !Path::new(path).is_absolute() {
        return Err(RpcError::invalid("path must be absolute"));
    }
    let forbidden = || RpcError::new("path_forbidden", format!("{path} is outside {}", home.display()));
    // A path that does not exist is `not_found` only under home: outside it,
    // the answer must not say whether something is there.
    let under_home = Path::new(path).starts_with(home) || dirs::home_dir().is_some_and(|raw| Path::new(path).starts_with(raw));
    let resolved = crate::paths::canonicalize(path).map_err(|_| if under_home { RpcError::not_found(format!("{path} does not exist")) } else { forbidden() })?;
    if !resolved.starts_with(home) {
        return Err(forbidden());
    }
    if !resolved.is_dir() {
        return Err(RpcError::not_found(format!("{path} is not a folder")));
    }
    Ok(resolved)
}

/// An optional string parameter: absent or null is `None`, anything but a
/// string is refused.
fn optional_str<'a>(params: &'a Value, name: &str) -> Result<Option<&'a str>, RpcError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(RpcError::invalid(format!("{name} must be a string"))),
    }
}

fn required_str<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    optional_str(params, name)?.ok_or_else(|| RpcError::invalid(format!("{name} is required")))
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `machine.browse`: the folders directly inside `path` (default `home`).
pub fn browse(home: &Path, params: &Value) -> Result<Value, RpcError> {
    let folder = resolve_folder(home, optional_str(params, "path")?)?;
    let projects = machine::ids_by_path();
    let read = std::fs::read_dir(&folder).map_err(|error| RpcError::not_found(format!("cannot list {}: {error}", folder.display())))?;
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for entry in read.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if name.starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let path = if kind.is_dir() {
            entry.path()
        } else if kind.is_symlink() {
            // A link counts as the folder it leads to, while that stays under home.
            match crate::paths::canonicalize(entry.path()) {
                Ok(target) if target.starts_with(home) && target.is_dir() => target,
                _ => continue,
            }
        } else {
            continue;
        };
        entries.push((name, path));
    }
    entries.sort_by(|(a, _), (b, _)| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    let listed: Vec<Value> = entries
        .into_iter()
        .map(|(name, path)| {
            let shown = display(&path);
            json!({ "name": name, "projectId": projects.get(&shown), "git": repository(&path), "path": shown })
        })
        .collect();
    let parent = (folder != home).then(|| folder.parent().map(display)).flatten();
    Ok(json!({ "home": display(home), "path": display(&folder), "parent": parent, "entries": listed, "truncated": truncated }))
}

/// `{ branch, github }` for a folder holding a Git repository, from its own
/// files: `HEAD` for the branch (null when detached) and `config` for
/// whether `origin` is on github.com. No `git` process runs.
pub fn repository(folder: &Path) -> Option<Value> {
    let dot_git = folder.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;
    let git_dir = if meta.is_dir() {
        dot_git
    } else if meta.is_file() {
        // A worktree or submodule: `gitdir: <path>`, relative to the folder.
        let pointer = std::fs::read_to_string(&dot_git).ok()?;
        let target = pointer.lines().find_map(|line| line.strip_prefix("gitdir:"))?.trim();
        folder.join(target)
    } else {
        return None;
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let branch = head.trim().strip_prefix("ref:").map(str::trim).and_then(|reference| reference.strip_prefix("refs/heads/")).map(str::to_string);
    // A linked worktree keeps its config in the repository it belongs to.
    let common = std::fs::read_to_string(git_dir.join("commondir")).ok().map(|common| git_dir.join(common.trim())).unwrap_or_else(|| git_dir.clone());
    let github = std::fs::read_to_string(common.join("config")).ok().and_then(|config| origin_url(&config)).is_some_and(|url| crate::issues::github_repo_from_url(&url).is_some());
    Some(json!({ "branch": branch, "github": github }))
}

/// `url` of `[remote "origin"]` in a Git config file.
fn origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            let section: String = line.trim_start_matches('[').trim_end_matches(']').split_whitespace().collect::<Vec<_>>().join(" ");
            in_origin = section == "remote \"origin\"";
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim().eq_ignore_ascii_case("url") {
                return Some(value.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

/// `machine.addProject`: the folder becomes a project of the machine, or is
/// returned as it is when it already is one. The caller emits
/// `projects_changed`.
pub fn add(home: &Path, params: &Value) -> Result<Value, RpcError> {
    let folder = resolve_folder(home, Some(required_str(params, "path")?))?;
    let project = crate::store::projects::ensure(&display(&folder)).map_err(|error| RpcError::new("invalid_project", format!("{error:#}")))?;
    Ok(json!({ "project": machine::project_row(&project) }))
}

/// `machine.removeProject`: the project leaves the machine's store. Its
/// folder, worktrees and sessions' records stay on disk. The caller emits
/// `projects_changed`.
pub fn remove(params: &Value) -> Result<Value, RpcError> {
    let id = required_str(params, "projectId")?;
    let project = machine::registered()?.into_iter().find(|project| machine::project_id(&project.path) == id).ok_or_else(|| RpcError::not_found(format!("no project {id} on this machine")))?;
    crate::store::projects::remove(&project.path).map_err(RpcError::internal)?;
    Ok(json!({ "removed": true }))
}

/// A clone's state, as `MachineClone` says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneState {
    Cloning,
    Done,
    Failed,
    Canceled,
}

impl CloneState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cloning => "cloning",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

#[derive(Debug, Clone)]
struct CloneEntry {
    repository: String,
    path: String,
    state: CloneState,
    stage: Option<String>,
    percent: Option<u8>,
    project: Option<Value>,
    error: Option<Failure>,
    finished: Option<Instant>,
}

impl CloneEntry {
    fn to_json(&self, id: &str) -> Value {
        json!({
            "cloneId": id,
            "repository": self.repository,
            "path": self.path,
            "state": self.state.as_str(),
            "stage": self.stage,
            "percent": self.percent,
            "project": self.project,
            "error": self.error.as_ref().map(|error| json!({ "code": error.code, "message": error.message })),
        })
    }

    fn finish(&mut self, state: CloneState, project: Option<Value>, error: Option<Failure>) {
        self.state = state;
        self.project = project;
        self.error = error;
        self.finished = Some(Instant::now());
    }
}

/// This runtime's clones by `cloneId`: running ones, and finished ones for
/// [`FINISHED_KEPT_FOR`].
#[derive(Default)]
pub struct Clones {
    entries: Mutex<HashMap<String, CloneEntry>>,
}

impl Clones {
    fn prune(entries: &mut HashMap<String, CloneEntry>) {
        entries.retain(|_, entry| entry.finished.is_none_or(|at| at.elapsed() < FINISHED_KEPT_FOR));
    }

    /// `machine.cloneProject`: check `parent`, then clone on a thread of its
    /// own and answer at once. Once whole, the folder is added as a project
    /// and `projects_changed` is emitted on `sink`.
    pub fn start(self: &Arc<Self>, home: &Path, params: &Value, sink: Arc<dyn EventSink>) -> Result<Value, RpcError> {
        let repository = required_str(params, "repository")?.to_string();
        let parent = resolve_folder(home, Some(required_str(params, "parent")?))?;
        let id = format!("clone-{}", uuid::Uuid::new_v4().simple());
        let mut entry = CloneEntry { repository: repository.clone(), path: display(&parent), state: CloneState::Cloning, stage: None, percent: None, project: None, error: None, finished: None };
        let source = match project_start::parse_source(&repository) {
            Ok(source) => source,
            Err(failure) => {
                entry.finish(CloneState::Failed, None, Some(failure));
                let answer = entry.to_json(&id);
                let mut entries = self.entries.lock().unwrap();
                Self::prune(&mut entries);
                entries.insert(id, entry);
                return Ok(json!({ "clone": answer }));
            }
        };
        entry.path = display(&parent.join(&source.name));
        let answer = entry.to_json(&id);
        {
            let mut entries = self.entries.lock().unwrap();
            Self::prune(&mut entries);
            entries.insert(id.clone(), entry);
        }
        let clones = self.clone();
        let parent = display(&parent);
        let spawned = std::thread::Builder::new().name("machine-clone".into()).spawn(move || clones.run(&id, &repository, &parent, &*sink));
        if let Err(error) = spawned {
            return Err(RpcError::internal(format!("start the clone: {error}")));
        }
        Ok(json!({ "clone": answer }))
    }

    fn run(self: &Arc<Self>, id: &str, repository: &str, parent: &str, sink: &dyn EventSink) {
        let progress = Arc::downgrade(self);
        let progress_id = id.to_string();
        let cloned = project_start::clone_repository(id, repository, parent, move |step| {
            let Some(clones) = progress.upgrade() else { return };
            if let Some(entry) = clones.entries.lock().unwrap().get_mut(&progress_id).filter(|entry| entry.state == CloneState::Cloning) {
                entry.stage = Some(step.stage);
                entry.percent = step.percent;
            };
        });
        let (state, project, error) = match cloned {
            Ok(outcome) => match crate::store::projects::ensure(&outcome.path) {
                Ok(project) => {
                    sink.emit("projects_changed", &());
                    (CloneState::Done, Some(machine::project_row(&project)), None)
                }
                Err(error) => (CloneState::Failed, None, Some(Failure { code: project_start::FAILED, message: format!("The clone finished but could not be added as a project: {error:#}") })),
            },
            Err(failure) if failure.code == project_start::CANCELED => (CloneState::Canceled, None, None),
            Err(failure) => (CloneState::Failed, None, Some(failure)),
        };
        if let Some(entry) = self.entries.lock().unwrap().get_mut(id) {
            entry.finish(state, project, error);
        }
    }

    /// `machine.cloneStatus`.
    pub fn status(&self, params: &Value) -> Result<Value, RpcError> {
        let id = required_str(params, "cloneId")?;
        let mut entries = self.entries.lock().unwrap();
        Self::prune(&mut entries);
        let entry = entries.get(id).ok_or_else(|| RpcError::not_found(format!("no clone {id}")))?;
        Ok(json!({ "clone": entry.to_json(id) }))
    }

    /// `machine.cloneCancel`: git is stopped and what it fetched is removed;
    /// the state turns `canceled` once it has. A finished clone is returned
    /// as it ended.
    pub fn cancel(&self, params: &Value) -> Result<Value, RpcError> {
        let id = required_str(params, "cloneId")?;
        let mut entries = self.entries.lock().unwrap();
        Self::prune(&mut entries);
        let entry = entries.get(id).ok_or_else(|| RpcError::not_found(format!("no clone {id}")))?;
        if entry.state == CloneState::Cloning {
            project_start::cancel_clone(id);
        }
        Ok(json!({ "clone": entry.to_json(id) }))
    }
}

#[cfg(test)]
#[path = "machine_projects_tests.rs"]
mod tests;
