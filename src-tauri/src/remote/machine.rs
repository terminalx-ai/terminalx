//! `machine/1` (PRO-340, docs/MACHINES.md): one runtime serving every project
//! of the machine it runs on, over one connection.
//!
//! - A project is one the machine's store already knows (`store::projects`),
//!   named by a `projectId` derived from its path, never by the path itself.
//! - Calls that name no session, tab, terminal, pipeline, search or watch take
//!   the `projectId`; their paths stay inside that project's folder and its
//!   own worktrees ([`ServedProject`]).
//! - A machine connection is never granted `keys/1`, `mirror/1` or
//!   `collab/1`, which belong to a cloud workspace's API and organisation.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::files::WorkspaceFiles;
use super::git::WorkspaceGit;
use super::protocol::RpcError;
use crate::store::projects::{Project, ProjectKind};

pub const MACHINE: &str = "machine/1";

/// `machine/2` (PRO-345): `directEndpoints` in `machine.describe` and
/// `machine.changed`, and `machine.relayAccess` for a paired computer
/// (docs/MACHINES.md, "As built (PRO-345)").
pub const MACHINE_2: &str = "machine/2";

/// `machine/3` (PRO-354): `machine.updateStatus`, `machine.update` and the
/// `machine.updateChanged` notification (docs/MACHINES.md, "Versions and
/// updates (PRO-354)"; `machine_update.rs`).
pub const MACHINE_3: &str = "machine/3";

/// `machine/4` (PRO-350): `machine.agentSetup` and
/// `machine.agentSetupRunning`, an agent's install or sign-in in a terminal
/// on the machine (docs/MACHINES.md, "As built (PRO-350): the machine page").
pub const MACHINE_4: &str = "machine/4";

/// `machine/5` (PRO-357): `machine.rotateCredential`, a fresh device token
/// each time a computer connects (docs/MACHINES.md, "Trust model").
pub const MACHINE_5: &str = "machine/5";
/// `machine/6` (PRO-351): `machine.browse`, `machine.addProject`,
/// `machine.removeProject` and the clone calls, a machine's projects from
/// another computer (docs/MACHINES.md, "As built (PRO-351)";
/// `machine_projects.rs`).
pub const MACHINE_6: &str = "machine/6";

/// `machine/7` (PRO-403): `machine.sessionActions`, `machine.runAction`,
/// `machine.setupRerun` and `machine.setupStop`, a machine session's Setup
/// and Run from another computer (docs/MACHINES.md, "As built (PRO-403)").
pub const MACHINE_7: &str = "machine/7";

/// `machine/8` (PRO-408): `session.usage`, `session.prepareContinuation` and
/// `session.checkFailures`, a machine session's cost chip, Continue in a new
/// tab and Fix check errors read and done on the machine (docs/MACHINES.md
/// "Session feature parity"; `machine_session.rs`).
pub const MACHINE_8: &str = "machine/8";

/// Namespaces a machine connection is never granted: the content key opens
/// checkpoints the cloud API keeps, the mirror is a cloud workspace's, and
/// sharing with other people is out of scope (docs/MACHINES.md, Method table).
pub const WITHHELD: [&str; 3] = ["keys/1", "mirror/1", "collab/1"];

/// Methods of namespaces a machine does grant that it does not serve: each
/// exists for a cloud workspace's mailbox, API or lifecycle.
pub const UNSERVED: [&str; 4] = ["session.nudge", "pipeline.noteMerge", "pipeline.noteTracker", "lifecycle.dispositionFacts"];

/// How often to discover new registrations. Existing registrations are
/// checked against disk whenever a path uses them.
const WORKTREES_FRESH_FOR: Duration = Duration::from_secs(2);

/// Whether `method` with `params` names a project rather than something the
/// runtime resolves (a session, tab, terminal, pipeline, search or watch).
pub fn needs_project(method: &str, params: &Value) -> bool {
    match method {
        "session.create" => true,
        // A session's terminal opens in that session's folder (`pty/2`).
        "pty.create" => params.get("sessionId").is_none_or(Value::is_null),
        "fs.cancel" | "fs.unwatch" => false,
        _ => method.starts_with("fs.") || method.starts_with("git."),
    }
}

/// `projectId`: the first 16 base64url characters of
/// `SHA-256("terminalx-project-id/1" || 0x00 || path)`, for the path the
/// machine's store keys the project by. Derived, never stored.
pub fn project_id(path: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"terminalx-project-id/1");
    digest.update([0u8]);
    digest.update(path.as_bytes());
    URL_SAFE_NO_PAD.encode(digest.finalize())[..16].to_string()
}

/// Who this machine is, from what hosts it.
#[derive(Debug, Clone)]
pub struct Identity {
    /// The relay host id of the machine's host key (`HostKeypair::host_id`).
    pub machine_id: String,
    /// A desktop app runs here, or the runtime is headless.
    pub has_window: bool,
}

/// `machine.describe`. `machine/2` adds `directEndpoints`, which only the
/// runtime's machine host knows ([`MachineAccess::direct_endpoints`]).
pub fn describe(identity: &Identity) -> Value {
    json!({
        "machineId": identity.machine_id,
        "name": crate::machine_name::current().name,
        "os": { "family": os_family(), "version": os_version() },
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "hasWindow": identity.has_window,
    })
}

/// What a machine's host adds to its workspace RPC (`machine/2`, PRO-345):
/// the addresses its direct listener answers on, and relay access for a
/// paired computer. The runtime's `machine_host` answers both.
pub trait MachineAccess: Send + Sync + 'static {
    /// The machine's current `ws://…:6768/machine/1` addresses, computed as
    /// for a pairing code; empty while nothing listens.
    fn direct_endpoints(&self) -> Vec<String>;
    /// `machine.relayAccess` for the connection of `device_id` (a paired
    /// computer's id on the direct route, its relay device id on the
    /// relay): `{ relay: {…} }` with a fresh single-use invite, or
    /// `{ relay: null }` with no relay registration.
    fn relay_access(&self, device_id: &str) -> futures_util::future::BoxFuture<'static, Result<Value, RpcError>>;
    /// The paired computers connected now, other than the one connected as
    /// `caller` (a paired computer's id on the direct route, its relay
    /// device id on the relay); every one when `caller` is `None`
    /// (`machine/3` `otherComputers`).
    fn other_computers(&self, caller: Option<&str>) -> Vec<super::machine_update::OtherComputer>;
    /// A desktop window is attached to this runtime now, so the app on this
    /// machine can run its updater (`machine/3`, `method: "app"`).
    fn window_available(&self) -> bool;
    /// Put what the connection of `device_id` did in the machine's activity
    /// log (PRO-357): `method` succeeded in `project_id`, with `detail` (a
    /// version). Never a prompt, a command or a file's contents.
    fn note(&self, _device_id: &str, _method: &str, _project_id: Option<&str>, _detail: Option<&str>) {}
    /// `machine.rotateCredential` for the connection of `device_id`:
    /// `{ deviceToken }`, a fresh token the computer keeps in place of its own.
    fn rotate_credential(&self, _device_id: &str) -> futures_util::future::BoxFuture<'static, Result<Value, RpcError>> {
        Box::pin(async { Err(RpcError::new("method_not_found", "this runtime does not rotate credentials")) })
    }
}

/// `macos` or `linux`, as Rust names them.
fn os_family() -> &'static str {
    std::env::consts::OS
}

/// The operating system's own version: `15.3` on macOS, `24.04` on Ubuntu.
fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()?;
        let version = String::from_utf8(output.stdout).ok()?.trim().to_string();
        (output.status.success() && !version.is_empty()).then_some(version)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let release = std::fs::read_to_string("/etc/os-release").ok()?;
        release.lines().find_map(|line| line.strip_prefix("VERSION_ID=")).map(|value| value.trim_matches('"').to_string()).filter(|value| !value.is_empty())
    }
}

pub(super) fn registered() -> Result<Vec<Project>, RpcError> {
    crate::store::projects::list().map(|(projects, _)| projects).map_err(RpcError::internal)
}

/// `machine.projects`: every project the machine knows, archived ones too
/// (they say so), in the store's order.
pub fn projects() -> Result<Value, RpcError> {
    let listed: Vec<Value> = registered()?.iter().map(project_row).collect();
    Ok(json!({ "projects": listed }))
}

/// One project as `machine.projects` lists it, and as `machine/6` returns
/// the one it added.
pub fn project_row(project: &Project) -> Value {
    let git = project.kind == ProjectKind::Git;
    json!({
        "projectId": project_id(&project.path),
        "name": project.name,
        "path": project.path,
        "kind": if git { "git" } else { "folder" },
        "defaultBranch": if git { crate::git::default_branch(Path::new(&project.path)) } else { None },
        "archived": project.archived,
    })
}

/// What `machine.changed` compares: the name and the project set.
pub fn fingerprint() -> Option<String> {
    let projects: Vec<(String, String, bool, bool)> = registered()
        .ok()?
        .into_iter()
        .map(|project| (project.path, project.name, project.archived, project.kind == ProjectKind::Git))
        .collect();
    Some(format!("{}\u{0}{projects:?}", crate::machine_name::current().name))
}

/// The machine's projects by path, as sessions and pipelines name theirs.
pub fn ids_by_path() -> HashMap<String, String> {
    registered().unwrap_or_default().into_iter().map(|project| (project_id(&project.path), project.path)).map(|(id, path)| (path, id)).collect()
}

pub(super) struct WorktreeRegistration {
    pub path: PathBuf,
    admin: PathBuf,
}

impl WorktreeRegistration {
    /// Recheck both Git pointers before authorizing a cached checkout.
    pub fn is_current(&self) -> bool {
        let marker = self.path.join(".git");
        git_link(&marker, "gitdir: ") == Some(self.admin.clone())
            && git_link(&self.admin.join("gitdir"), "") == Some(marker)
    }
}

/// Git writes these pointers in both directions, relative to the pointer
/// file's directory or as absolute paths.
fn git_link(file: &Path, prefix: &str) -> Option<PathBuf> {
    let meta = std::fs::symlink_metadata(file).ok()?;
    if !meta.is_file() || meta.len() > 8192 {
        return None;
    }
    let mut text = String::new();
    std::fs::File::open(file).ok()?.take(8193).read_to_string(&mut text).ok()?;
    let link = text.trim_end_matches(['\r', '\n']).strip_prefix(prefix)?;
    if link.is_empty() || text.len() > 8192 {
        return None;
    }
    std::fs::canonicalize(file.parent()?.join(link)).ok()
}

/// Linked worktrees registered in this project's Git repository. A settings
/// change only affects where future worktrees are created.
pub(super) fn worktrees(project: &Path) -> Vec<WorktreeRegistration> {
    let Some(registry) = crate::git::common_dir(project).map(|common| common.join("worktrees")) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&registry) else { return Vec::new() };
    let mut found: Vec<_> = entries.filter_map(Result::ok).filter_map(|entry| {
        let admin = entry.path();
        if !entry.file_type().ok()?.is_dir() || std::fs::canonicalize(&admin).ok()? != admin {
            return None;
        }
        let marker = git_link(&admin.join("gitdir"), "")?;
        if marker.file_name()? != ".git" {
            return None;
        }
        let path = marker.parent()?.to_path_buf();
        let registration = WorktreeRegistration { path, admin };
        (registration.path != project && registration.is_current()).then_some(registration)
    }).collect();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// One project as the calls that name it are served: its canonical folder,
/// and the files and Git of that folder alone.
pub struct ServedProject {
    /// `None` for a cloud workspace or `--project-root` runtime's one root.
    pub id: Option<String>,
    pub root: PathBuf,
    pub files: Arc<WorkspaceFiles>,
    pub git: WorkspaceGit,
    refreshed: Mutex<Option<Instant>>,
}

impl ServedProject {
    /// The one root of a workspace runtime, served as before `machine/1`.
    pub fn workspace(root: PathBuf) -> Self {
        let files = Arc::new(WorkspaceFiles::new(root.clone()));
        Self { id: None, git: WorkspaceGit::new(root.clone(), files.clone()), files, root, refreshed: Mutex::new(None) }
    }

    fn machine(id: String, root: PathBuf) -> Self {
        let files = Arc::new(WorkspaceFiles::new(root.clone()));
        Self { id: Some(id), git: WorkspaceGit::for_project(root.clone(), files.clone()), files, root, refreshed: Mutex::new(None) }
    }

    /// Bring the worktrees an absolute path may name up to date, at most
    /// every [`WORKTREES_FRESH_FOR`]: one made since is reachable, one
    /// removed is not. Only a machine project has any.
    pub fn refresh(&self) {
        if self.id.is_none() {
            return;
        }
        let mut refreshed = self.refreshed.lock().unwrap();
        if refreshed.is_some_and(|at| at.elapsed() < WORKTREES_FRESH_FOR) {
            return;
        }
        self.files.set_worktrees(worktrees(&self.root));
        *refreshed = Some(Instant::now());
    }

    /// The session's authorized checkout in fs/1 and git/1 coordinates.
    pub fn session_checkout(&self, session: &crate::store::index::SessionEntry) -> Option<(String, Option<String>)> {
        if session.worktree_removed {
            return None;
        }
        let cwd = std::fs::canonicalize(&session.cwd).ok()?;
        if !cwd.is_dir() {
            return None;
        }
        let mut checkout = self.files.containing_worktree(&cwd);
        if checkout.is_none() && cwd != self.root && (session.worktree_name.is_some() || !cwd.starts_with(&self.root)) {
            // A newly created checkout can arrive before the next discovery.
            self.files.set_worktrees(worktrees(&self.root));
            checkout = self.files.containing_worktree(&cwd);
        }
        if let Some(checkout) = checkout {
            let name = self.files.relative(&checkout);
            return Some((name.clone(), Some(name)));
        }
        cwd.starts_with(&self.root).then(|| (String::new(), self.git.project_has_git().then(|| ".".into())))
    }
}

/// A machine's projects as served, made when first named and kept while
/// their folder stays the same.
#[derive(Default)]
pub struct Projects {
    served: Mutex<HashMap<String, Arc<ServedProject>>>,
}

impl Projects {
    /// The project `id` names, read from the store each time so a project
    /// added or removed on the machine is served or refused at once.
    pub fn get(&self, id: &str) -> Result<Arc<ServedProject>, RpcError> {
        let project = registered()?.into_iter().find(|project| project_id(&project.path) == id);
        let Some(project) = project else {
            self.served.lock().unwrap().remove(id);
            return Err(RpcError::not_found(format!("no project {id} on this machine")));
        };
        self.get_at(id, &project.path)
    }

    /// Use a path from the registered-project snapshot used to list sessions.
    pub fn get_at(&self, id: &str, path: &str) -> Result<Arc<ServedProject>, RpcError> {
        let root = std::fs::canonicalize(path).map_err(|_| RpcError::not_found(format!("the folder of project {id} is gone")))?;
        let mut served = self.served.lock().unwrap();
        if let Some(existing) = served.get(id).filter(|existing| existing.root == root) {
            let existing = existing.clone();
            drop(served);
            existing.refresh();
            return Ok(existing);
        }
        let fresh = Arc::new(ServedProject::machine(id.to_string(), root));
        served.insert(id.to_string(), fresh.clone());
        drop(served);
        fresh.refresh();
        Ok(fresh)
    }

    /// Every project served so far: searches and uploads live in each.
    pub fn served(&self) -> Vec<Arc<ServedProject>> {
        self.served.lock().unwrap().values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_ids_match_the_architecture_notes_vectors() {
        assert_eq!(project_id("/Users/me/code/terminalx"), "1_xp39fWQj0RTKD0");
        assert_eq!(project_id("/home/me/repos/terminalx"), "oV5UO5z-ckp09tDS");
        let id = project_id("/any/where");
        assert_eq!(id.len(), 16);
        assert!(id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
    }

    #[test]
    fn project_calls_are_the_ones_that_name_no_runtime_object() {
        for method in ["session.create", "fs.read", "fs.watch", "fs.search", "git.status", "git.repositories"] {
            assert!(needs_project(method, &json!({})), "{method}");
        }
        assert!(needs_project("pty.create", &json!({ "sessionId": null })));
        for (method, params) in [("pty.create", json!({ "sessionId": "s" })), ("fs.cancel", json!({})), ("fs.unwatch", json!({})), ("session.list", json!({})), ("pipeline.act", json!({}))] {
            assert!(!needs_project(method, &params), "{method}");
        }
    }
}
