//! Finding what earlier deletes left on disk, and removing it on request.
//!
//! Three kinds of leftover, each tied to a project the app knows:
//!
//! - **worktree**: a directory in the project's worktree folder that no
//!   session runs in;
//! - **agent data**: conversations Claude Code or Codex kept for a managed
//!   worktree that is gone and that no session refers to;
//! - **branch**: a `raccoon/*` branch with no worktree.
//!
//! The scan only reads (and fetches each project's default branch, so
//! "merged" is about now). Removing takes the ids the person confirmed,
//! scans again, and deletes only what the fresh scan still calls removable,
//! so a session started or a commit made since the list was shown is
//! respected.
//!
//! Work is never lost here. A worktree or a branch is removable only when
//! the clean-and-merged check ([`crate::landed`]) finds it safe: nothing
//! uncommitted, untracked or stashed, and everything on it in the default
//! branch, verified against the remote. Anything else is listed with the
//! reason it is kept and can only be removed from the workspace dialog,
//! which asks for the second confirmation. Deletes are direct; nothing goes
//! to the Trash.

use std::collections::HashSet;
use std::io::BufRead;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::agent_data;
use crate::git;
use crate::harness::claude::transcript::encoded_cwd;
use crate::landed::{self, Fetch};
use crate::store::index::SessionEntry;
use crate::store::projects::Project;

/// How far into a transcript to look for the directory it was written in.
const CWD_SCAN_LINES: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LeftoverKind {
    Worktree,
    AgentData,
    Branch,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Leftover {
    /// Stable across scans; what a removal request names.
    pub id: String,
    pub kind: LeftoverKind,
    pub project_path: String,
    pub project_name: String,
    /// The worktree's name, or the branch.
    pub name: String,
    /// `Claude` or `Codex`, for agent data.
    pub agent: Option<String>,
    /// What would be deleted. Empty for a branch.
    pub paths: Vec<String>,
    pub size_bytes: u64,
    /// Why the clean-up will not remove this. `None` when it can.
    pub kept_because: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failed {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub removed: Vec<String>,
    pub failed: Vec<Failed>,
    pub freed_bytes: u64,
}

/// Everything the scan reads, so tests can hand it temporary places.
pub(crate) struct Sources<'a> {
    pub projects: &'a [Project],
    pub sessions: &'a [SessionEntry],
    pub claude_root: Option<&'a Path>,
    pub codex_home: Option<&'a Path>,
    pub fetch: Fetch,
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether any session runs in `dir` or below it.
fn used_by_a_session(sessions: &[SessionEntry], dir: &Path) -> bool {
    let dir = canonical(dir);
    sessions.iter().any(|session| !session.cwd.is_empty() && canonical(Path::new(&session.cwd)).starts_with(&dir))
}

/// What a project's branches are compared with, read once per project.
struct Base {
    name: Option<String>,
    not_verified: Option<String>,
    /// The remote default branch was fetched for this scan.
    fresh: bool,
}

fn worktree_leftovers(project: &Project, base: &Base, sessions: &[SessionEntry], out: &mut Vec<Leftover>) {
    let project_path = Path::new(&project.path);
    let root = git::worktree_root(project_path);
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Some(name) = entry.file_name().to_str().map(String::from) else { continue };
        let Ok(path) = git::managed_worktree_path(project_path, &name) else { continue };
        // A link is never a worktree Raccoon made, and is never followed.
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        if used_by_a_session(sessions, &path) {
            continue;
        }
        let claimed = sessions.iter().any(|session| {
            !session.worktree_removed && session.worktree_name.as_deref() == Some(name.as_str()) && canonical(Path::new(&session.project_path)) == canonical(project_path)
        });
        if claimed {
            continue;
        }
        // The project's default branch was fetched once for the whole scan.
        let state = landed::check(project_path, &path, if base.fresh { Fetch::JustFetched } else { Fetch::Skip });
        let kept_because = if !state.checked {
            Some("Not a working git checkout of this project, so it cannot be checked for unsaved work. Delete it by hand if it is not needed.".to_string())
        } else if let Some(reason) = base.not_verified.as_ref().or(state.not_verified.as_ref()) {
            Some(format!("Not verified: {reason}"))
        } else if !state.safe {
            Some(format!("{} Delete the workspace from the sidebar if that is intended.", state.losses.join(" ")))
        } else {
            None
        };
        out.push(Leftover {
            id: format!("worktree:{}:{name}", project.path),
            kind: LeftoverKind::Worktree,
            project_path: project.path.clone(),
            project_name: project.name.clone(),
            name,
            agent: None,
            size_bytes: git::size_on_disk(&path),
            paths: vec![path.to_string_lossy().into_owned()],
            kept_because,
        });
    }
}

fn branch_leftovers(project: &Project, base: &Base, sessions: &[SessionEntry], out: &mut Vec<Leftover>) {
    let project_path = Path::new(&project.path);
    let prefix = crate::store::settings::load().branch_prefix;
    // Without a prefix every branch would look like one of Raccoon's.
    if prefix.is_empty() {
        return;
    }
    let Ok(worktrees) = git::list_worktrees(project_path) else { return };
    let checked_out: HashSet<String> = worktrees.into_iter().filter_map(|(_, branch)| branch).collect();
    let Ok(refs) = git::run(project_path, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]) else { return };
    for branch in refs.lines().map(str::trim) {
        let Some(name) = branch.strip_prefix(&prefix) else { continue };
        if name.is_empty() || checked_out.contains(branch) {
            continue;
        }
        // A directory of that name is listed as a worktree instead.
        if git::managed_worktree_path(project_path, name).is_ok_and(|path| std::fs::symlink_metadata(path).is_ok()) {
            continue;
        }
        let in_use = sessions.iter().any(|session| session.branch.as_deref() == Some(branch) && canonical(Path::new(&session.project_path)) == canonical(project_path));
        if in_use {
            continue;
        }
        let kept_because = match (&base.not_verified, &base.name) {
            (Some(reason), _) => Some(format!("Not verified: {reason}")),
            (None, None) => Some("There is nothing to compare the branch with.".to_string()),
            (None, Some(base)) => match landed::merged_rev(project_path, base, branch) {
                Some((Some(_), _)) => None,
                Some((None, unmerged)) => Some(format!("Has {unmerged} commit{} not in {base}.", if unmerged == 1 { "" } else { "s" })),
                None => Some("Git could not compare the branch, so it is kept.".to_string()),
            },
        };
        out.push(Leftover {
            id: format!("branch:{}:{branch}", project.path),
            kind: LeftoverKind::Branch,
            project_path: project.path.clone(),
            project_name: project.name.clone(),
            name: branch.to_string(),
            agent: None,
            paths: Vec::new(),
            size_bytes: 0,
            kept_because,
        });
    }
}

/// The project whose managed worktree `cwd` was, when that worktree is known
/// to be gone from disk (not merely unreadable) and no session refers to it.
fn gone_worktree_of<'a>(projects: &'a [Project], sessions: &[SessionEntry], cwd: &str) -> Option<(&'a Project, String)> {
    let path = Path::new(cwd);
    let gone = matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    if !path.is_absolute() || !gone {
        return None;
    }
    let name = path.file_name()?.to_str()?.to_string();
    let project = projects.iter().find(|project| {
        std::fs::symlink_metadata(&project.path).is_ok() && git::managed_worktree_path(Path::new(&project.path), &name).is_ok_and(|managed| managed == path)
    })?;
    let key = agent_data::folder_key(cwd);
    let referred = sessions.iter().flat_map(agent_data::session_dirs).any(|dir| agent_data::folder_key(dir) == key);
    (!referred).then_some((project, name))
}

/// The directory a Claude transcript says it was written in.
fn recorded_cwd(transcript: &Path) -> Option<String> {
    let file = std::fs::File::open(transcript).ok()?;
    std::io::BufReader::new(file)
        .lines()
        .take(CWD_SCAN_LINES)
        .map_while(|line| line.ok())
        .find_map(|line| serde_json::from_str::<serde_json::Value>(&line).ok()?.get("cwd")?.as_str().map(String::from))
}

fn children(dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| entry.path()).collect();
    paths.sort();
    paths
}

/// The conversations in a Claude folder that are leftovers: every transcript
/// there, with its side folder, when all of them say they were written in
/// one managed worktree that is gone, and no session holds or has forked
/// from any of them. A folder with a transcript that says anything else, or
/// nothing, is left alone entirely: whose it is cannot be told.
fn claude_leftovers(root: &Path, projects: &[Project], sessions: &[SessionEntry], out: &mut Vec<Leftover>) {
    let Ok(root) = std::fs::canonicalize(root) else { return };
    let referenced = agent_data::referenced_conversations(sessions);
    let names: Vec<String> = children(&root).iter().filter_map(|path| path.file_name()?.to_str().map(String::from)).collect();
    for folder_name in names {
        let Some(folder) = agent_data::real_child_dir(&root, &folder_name) else { continue };
        let transcripts: Vec<PathBuf> = children(&folder)
            .into_iter()
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") && std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()))
            .collect();
        let Some(cwd) = transcripts.first().and_then(|path| recorded_cwd(path)) else { continue };
        if encoded_cwd(&cwd) != folder_name || !transcripts.iter().all(|path| recorded_cwd(path).as_deref() == Some(cwd.as_str())) {
            continue;
        }
        let ids: Vec<&str> = transcripts.iter().filter_map(|path| path.file_stem()?.to_str()).collect();
        if ids.len() != transcripts.len() || ids.iter().any(|id| agent_data::conversation_id(id).is_none() || referenced.contains(id)) {
            continue;
        }
        let Some((project, name)) = gone_worktree_of(projects, sessions, &cwd) else { continue };
        let mut paths = Vec::new();
        let mut size = 0;
        for (transcript, id) in transcripts.iter().zip(&ids) {
            size += git::size_on_disk(transcript);
            paths.push(transcript.to_string_lossy().into_owned());
            if let Some(side) = agent_data::real_child_dir(&folder, id) {
                size += git::size_on_disk(&side);
                paths.push(side.to_string_lossy().into_owned());
            }
        }
        out.push(Leftover {
            id: format!("claude:{folder_name}"),
            kind: LeftoverKind::AgentData,
            project_path: project.path.clone(),
            project_name: project.name.clone(),
            name,
            agent: Some("Claude".into()),
            size_bytes: size,
            paths,
            kept_because: None,
        });
    }
}

/// What a rollout's first record says: the conversation id and where it ran.
fn rollout_meta(rollout: &Path) -> Option<(String, String)> {
    let file = std::fs::File::open(rollout).ok()?;
    let line = std::io::BufReader::new(file).lines().next()?.ok()?;
    let record: serde_json::Value = serde_json::from_str(&line).ok()?;
    if record["type"] != "session_meta" {
        return None;
    }
    let payload = &record["payload"];
    Some((payload["id"].as_str()?.to_string(), payload["cwd"].as_str()?.to_string()))
}

fn codex_leftovers(home: &Path, projects: &[Project], sessions: &[SessionEntry], out: &mut Vec<Leftover>) {
    let Ok(sessions_root) = std::fs::canonicalize(home.join("sessions")) else { return };
    let referenced = agent_data::referenced_conversations(sessions);
    let mut found: Vec<Leftover> = Vec::new();
    for year in children(&sessions_root) {
        for month in children(&year) {
            for day in children(&month) {
                for rollout in children(&day) {
                    let is_file = std::fs::symlink_metadata(&rollout).is_ok_and(|meta| meta.is_file());
                    let is_rollout = rollout.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(".jsonl"));
                    if !is_file || !is_rollout || !agent_data::rollout_inside(&sessions_root, &rollout) {
                        continue;
                    }
                    let Some((id, cwd)) = rollout_meta(&rollout) else { continue };
                    // The id in the name is what resume looks for; both must agree.
                    let named_for_id = rollout.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(&format!("-{id}.jsonl")));
                    if !named_for_id || agent_data::conversation_id(&id).is_none() || referenced.contains(id.as_str()) {
                        continue;
                    }
                    let Some((project, name)) = gone_worktree_of(projects, sessions, &cwd) else { continue };
                    let leftover_id = format!("codex:{cwd}");
                    let size = git::size_on_disk(&rollout);
                    let path = rollout.to_string_lossy().into_owned();
                    match found.iter_mut().find(|leftover| leftover.id == leftover_id) {
                        Some(leftover) => {
                            leftover.paths.push(path);
                            leftover.size_bytes += size;
                        }
                        None => found.push(Leftover {
                            id: leftover_id,
                            kind: LeftoverKind::AgentData,
                            project_path: project.path.clone(),
                            project_name: project.name.clone(),
                            name,
                            agent: Some("Codex".into()),
                            paths: vec![path],
                            size_bytes: size,
                            kept_because: None,
                        }),
                    }
                }
            }
        }
    }
    out.extend(found);
}

pub(crate) fn scan_sources(sources: &Sources<'_>) -> Vec<Leftover> {
    let mut out = Vec::new();
    for project in sources.projects {
        let path = Path::new(&project.path);
        if !path.is_dir() || !git::is_repo(path) {
            continue;
        }
        let (name, not_verified, fresh) = landed::base_for(path, sources.fetch);
        // A comparison with a copy that was not fetched is not a verified one.
        let not_verified = not_verified.or_else(|| (!fresh).then(|| "the default branch was not fetched for this scan.".to_string()));
        let base = Base { name, not_verified, fresh };
        worktree_leftovers(project, &base, sources.sessions, &mut out);
        branch_leftovers(project, &base, sources.sessions, &mut out);
    }
    if let Some(root) = sources.claude_root {
        claude_leftovers(root, sources.projects, sources.sessions, &mut out);
    }
    if let Some(home) = sources.codex_home {
        codex_leftovers(home, sources.projects, sources.sessions, &mut out);
    }
    out
}

fn remove_one(leftover: &Leftover, sources: &Sources<'_>) -> std::result::Result<u64, String> {
    let project = Path::new(&leftover.project_path);
    match leftover.kind {
        LeftoverKind::Worktree => {
            // By path, through the same removal as every workspace. Never a
            // direct delete: a directory git cannot remove is reported.
            let path = git::managed_worktree_path(project, &leftover.name).map_err(|e| format!("{e:#}"))?;
            // Checked once more, against the default branch the scan fetched
            // a moment ago, for the commit it is safe at. Git is then not
            // forced (it refuses if a file appeared since) and the branch is
            // deleted only while it is still at that commit.
            let state = landed::check(project, &path, Fetch::JustFetched);
            let Some(head) = state.head.as_deref().filter(|_| state.safe) else {
                return Err("It is no longer clean and merged; it was not deleted.".into());
            };
            let options = crate::workspaces::DeleteOptions { delete_branch: true, direct: git::DirectDelete::Never, verified_head: Some(head) };
            crate::workspaces::delete(project, &path, options).map_err(|e| format!("{e:#}"))?;
            Ok(leftover.size_bytes)
        }
        LeftoverKind::Branch => {
            let prefix = crate::store::settings::load().branch_prefix;
            let plain = leftover.name.strip_prefix(&prefix).is_some_and(|name| !prefix.is_empty() && !name.is_empty() && !name.contains("..") && !name.starts_with('-'));
            if !plain || leftover.name.starts_with('-') {
                return Err("refusing to delete: not one of Raccoon's branches".into());
            }
            git::run(project, &["check-ref-format", "--branch", &leftover.name]).map_err(|e| format!("{e:#}"))?;
            git::run(project, &["branch", "-D", "--", &leftover.name]).map_err(|e| format!("{e:#}"))?;
            Ok(0)
        }
        LeftoverKind::AgentData if leftover.agent.as_deref() == Some("Claude") => {
            let root = sources.claude_root.and_then(|root| std::fs::canonicalize(root).ok()).ok_or("Claude's data folder is not there")?;
            let folder_name = leftover.id.strip_prefix("claude:").unwrap_or_default();
            let folder = agent_data::real_child_dir(&root, folder_name).ok_or("refusing to delete: not a folder under Claude's projects")?;
            let mut freed = 0;
            // Only the conversations the scan listed: a transcript and its
            // side folder, each a real entry directly in this folder.
            for path in leftover.paths.iter().map(Path::new) {
                if path.parent() != Some(folder.as_path()) {
                    continue;
                }
                match std::fs::symlink_metadata(path) {
                    Ok(meta) if meta.is_file() => freed += agent_data::remove_file_counted(path),
                    Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => freed += agent_data::remove_dir_counted(path),
                    _ => {}
                }
            }
            // What is not a conversation (memory, notes) stays, and then so
            // does the folder: `remove_dir` refuses one that is not empty.
            let _ = std::fs::remove_dir(&folder);
            Ok(freed)
        }
        LeftoverKind::AgentData => {
            let sessions_root = sources.codex_home.and_then(|home| std::fs::canonicalize(home.join("sessions")).ok()).ok_or("Codex's data folder is not there")?;
            let mut freed = 0;
            for path in leftover.paths.iter().map(Path::new) {
                if agent_data::rollout_inside(&sessions_root, path) {
                    freed += agent_data::remove_file_counted(path);
                }
            }
            Ok(freed)
        }
    }
}

/// Remove the leftovers named by `ids`. Each is looked up in a fresh scan:
/// one that is no longer a leftover, or that the scan would keep, is
/// reported as failed and left alone.
pub(crate) fn remove_from_sources(sources: &Sources<'_>, ids: &[String]) -> Removal {
    let fresh = scan_sources(sources);
    let mut removal = Removal::default();
    // Worktrees first: removing one also removes its branch when it can.
    let mut wanted: Vec<&String> = ids.iter().collect();
    wanted.sort_by_key(|id| !id.starts_with("worktree:"));
    wanted.dedup();
    for id in wanted {
        let outcome = match fresh.iter().find(|leftover| &leftover.id == id) {
            None => Err("This is no longer a leftover; it was not deleted.".to_string()),
            Some(Leftover { kept_because: Some(reason), .. }) => Err(reason.clone()),
            Some(leftover) => remove_one(leftover, sources),
        };
        match outcome {
            Ok(freed) => {
                removal.freed_bytes += freed;
                removal.removed.push(id.clone());
            }
            Err(error) => removal.failed.push(Failed { id: id.clone(), error }),
        }
    }
    removal
}

fn with_sources<R>(f: impl FnOnce(&Sources<'_>) -> R) -> anyhow::Result<R> {
    let (projects, _) = crate::store::projects::list()?;
    let sessions = crate::store::index::load()?;
    let claude_root = agent_data::claude_projects_root();
    let codex_home = agent_data::codex_managed_root();
    Ok(f(&Sources { projects: &projects, sessions: &sessions, claude_root: claude_root.as_deref(), codex_home: codex_home.as_deref(), fetch: Fetch::Fresh }))
}

/// What earlier deletes left behind, across every project the app knows.
pub fn scan() -> anyhow::Result<Vec<Leftover>> {
    with_sources(scan_sources)
}

/// Delete the confirmed leftovers. See [`remove_from_sources`].
pub fn remove(ids: &[String]) -> anyhow::Result<Removal> {
    with_sources(|sources| remove_from_sources(sources, ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::index::{self, TabEntry, TabStatus};
    use std::collections::BTreeMap;

    const CONV_A: &str = "11111111-1111-4111-8111-111111111111";
    const CONV_B: &str = "22222222-2222-4222-8222-222222222222";

    struct Fixture {
        _home: crate::store::TempHome,
        dir: tempfile::TempDir,
        project: Project,
        claude_root: PathBuf,
        codex_home: PathBuf,
    }

    fn sh(cwd: &Path, args: &[&str]) {
        git::run(cwd, args).unwrap_or_else(|e| panic!("git {args:?}: {e:#}"));
    }

    fn commit(cwd: &Path, file: &str) {
        std::fs::write(cwd.join(file), file).unwrap();
        sh(cwd, &["add", "."]);
        sh(cwd, &["commit", "-q", "-m", file]);
    }

    impl Fixture {
        fn new() -> Self {
            let home = crate::store::temp_home();
            let dir = tempfile::tempdir().unwrap();
            let base = std::fs::canonicalize(dir.path()).unwrap();
            // A bare remote, so "pushed" means something.
            let remote = base.join("remote.git");
            std::fs::create_dir_all(&remote).unwrap();
            sh(&remote, &["init", "-q", "--bare", "-b", "main"]);
            let path = base.join("project");
            std::fs::create_dir_all(&path).unwrap();
            sh(&path, &["init", "-q", "-b", "main"]);
            sh(&path, &["config", "user.email", "t@example.com"]);
            sh(&path, &["config", "user.name", "T"]);
            commit(&path, "a.txt");
            sh(&path, &["remote", "add", "origin", remote.to_str().unwrap()]);
            sh(&path, &["push", "-q", "-u", "origin", "main"]);
            let claude_root = base.join("home/.claude/projects");
            std::fs::create_dir_all(&claude_root).unwrap();
            let codex_home = base.join("codex");
            std::fs::create_dir_all(codex_home.join("sessions")).unwrap();
            let project: Project = serde_json::from_value(serde_json::json!({ "path": path, "name": "project" })).unwrap();
            Self { _home: home, dir, project, claude_root, codex_home }
        }

        fn path(&self) -> &Path {
            Path::new(&self.project.path)
        }

        fn worktree(&self, name: &str) -> PathBuf {
            PathBuf::from(git::create_worktree(self.path(), name, Some("main")).unwrap().path)
        }

        fn scan(&self, sessions: &[SessionEntry]) -> Vec<Leftover> {
            scan_sources(&self.sources(std::slice::from_ref(&self.project), sessions))
        }

        fn remove(&self, sessions: &[SessionEntry], ids: &[&str]) -> Removal {
            let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
            remove_from_sources(&self.sources(std::slice::from_ref(&self.project), sessions), &ids)
        }

        fn sources<'a>(&'a self, projects: &'a [Project], sessions: &'a [SessionEntry]) -> Sources<'a> {
            Sources { projects, sessions, claude_root: Some(&self.claude_root), codex_home: Some(&self.codex_home), fetch: Fetch::Fresh }
        }

        fn session(&self, cwd: &Path, tabs: Vec<TabEntry>) -> SessionEntry {
            SessionEntry {
                id: uuid::Uuid::now_v7().to_string(),
                kind: crate::store::index::SessionKind::Project,
                project_path: self.project.path.clone(),
                cwd: cwd.to_string_lossy().into_owned(),
                worktree_name: None,
                branch: None,
                base_ref: None,
                worktree_base: None,
                worktree_removed: false,
                removed_workspace: None,
                issue: None,
                automation: None,
                title: "t".into(),
                created: index::now(),
                modified: index::now(),
                archived: false,
                pinned: false,
                active_tab: None,
                tabs,
                unknown: BTreeMap::new(),
            }
        }

        fn claude_transcript(&self, cwd: &Path, conversation: &str) -> PathBuf {
            let folder = self.claude_root.join(encoded_cwd(&cwd.to_string_lossy()));
            std::fs::create_dir_all(&folder).unwrap();
            let file = folder.join(format!("{conversation}.jsonl"));
            std::fs::write(&file, format!("{}\n", serde_json::json!({ "type": "user", "cwd": cwd }))).unwrap();
            file
        }

        fn codex_rollout(&self, cwd: &Path, conversation: &str) -> PathBuf {
            let day = self.codex_home.join("sessions/2026/10/03");
            std::fs::create_dir_all(&day).unwrap();
            let file = day.join(format!("rollout-2026-10-03T10-00-00-{conversation}.jsonl"));
            std::fs::write(&file, format!("{}\n", serde_json::json!({ "type": "session_meta", "payload": { "id": conversation, "cwd": cwd } }))).unwrap();
            file
        }
    }

    fn tab(harness: &str, conversation: &str) -> TabEntry {
        TabEntry {
            id: uuid::Uuid::now_v7().to_string(),
            harness: harness.into(),
            title: None,
            model: String::new(),
            effort: None,
            permission_mode: "default".into(),
            provider_session_id: Some(conversation.into()),
            status: TabStatus::Idle,
            created: index::now(),
            modified: index::now(),
            context_used: None,
            context_max: None,
            fork_from: None,
            unknown: BTreeMap::new(),
        }
    }

    fn find<'a>(leftovers: &'a [Leftover], kind: LeftoverKind, name: &str) -> Option<&'a Leftover> {
        leftovers.iter().find(|leftover| leftover.kind == kind && leftover.name == name)
    }

    #[test]
    fn a_clean_worktree_with_no_session_is_listed_with_its_size_and_removed_on_request() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        std::fs::create_dir_all(wt.join("target")).unwrap();
        // An ignored build folder: the bulk of a real leftover, and not unsaved work.
        std::fs::write(wt.join("target/big.bin"), vec![7u8; 256 * 1024]).unwrap();
        std::fs::write(f.path().join(".git/info/exclude"), "/.raccoon/\ntarget/\n").unwrap();

        let leftovers = f.scan(&[]);
        let leftover = find(&leftovers, LeftoverKind::Worktree, "quiet-amber-fox").expect("listed");
        assert_eq!(leftover.kept_because, None);
        assert!(leftover.size_bytes >= 256 * 1024, "{}", leftover.size_bytes);
        assert_eq!(leftover.paths, vec![wt.to_string_lossy().into_owned()]);
        assert!(find(&leftovers, LeftoverKind::Branch, "raccoon/quiet-amber-fox").is_none(), "its branch is not listed twice");

        // Scanning deletes nothing.
        assert!(wt.join("a.txt").exists());

        let removal = f.remove(&[], &[&leftover.id]);
        assert_eq!(removal.failed, vec![]);
        assert_eq!(removal.removed, vec![leftover.id.clone()]);
        assert!(removal.freed_bytes >= 256 * 1024);
        assert!(!wt.exists());
        assert!(!git::worktree_branch_names(f.path()).contains(&"quiet-amber-fox".to_string()));
        assert!(f.scan(&[]).is_empty());
    }

    #[test]
    fn a_directory_a_session_uses_is_never_listed_or_removed() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let in_root = f.session(&wt, vec![]);
        let in_subdirectory = f.session(&wt.join("."), vec![]);
        let mut named = f.session(f.path(), vec![]);
        named.worktree_name = Some("quiet-amber-fox".into());
        for sessions in [vec![in_root], vec![in_subdirectory], vec![named]] {
            assert_eq!(f.scan(&sessions), vec![], "a live session's worktree and branch are not leftovers");
            // Even when asked by id, as a stale list would.
            let id = format!("worktree:{}:quiet-amber-fox", f.project.path);
            let removal = f.remove(&sessions, &[&id]);
            assert!(removal.removed.is_empty());
            assert_eq!(removal.failed.len(), 1);
            assert!(wt.join("a.txt").exists());
        }
    }

    #[test]
    fn uncommitted_or_unmerged_work_is_listed_but_never_removed() {
        let f = Fixture::new();
        let dirty = f.worktree("dirty-red-owl");
        std::fs::write(dirty.join("notes.txt"), "unsaved").unwrap();
        let ahead = f.worktree("ahead-blue-elk");
        sh(&ahead, &["config", "user.email", "t@example.com"]);
        commit(&ahead, "work.txt");
        // The same commit on a second raccoon branch does not make it saved.
        sh(f.path(), &["branch", "raccoon/twin", "raccoon/ahead-blue-elk"]);

        let leftovers = f.scan(&[]);
        let dirty_item = find(&leftovers, LeftoverKind::Worktree, "dirty-red-owl").unwrap();
        assert!(dirty_item.kept_because.as_deref().unwrap().contains("1 uncommitted file"), "{dirty_item:?}");
        let ahead_item = find(&leftovers, LeftoverKind::Worktree, "ahead-blue-elk").unwrap();
        assert!(ahead_item.kept_because.as_deref().unwrap().contains("1 commit is not in origin/main"), "{ahead_item:?}");
        let twin = find(&leftovers, LeftoverKind::Branch, "raccoon/twin").unwrap();
        assert!(twin.kept_because.as_deref().unwrap().contains("1 commit not in origin/main"), "{twin:?}");

        let removal = f.remove(&[], &[&dirty_item.id, &ahead_item.id, &twin.id]);
        assert!(removal.removed.is_empty());
        assert_eq!(removal.failed.len(), 3);
        assert_eq!(removal.freed_bytes, 0);
        assert!(dirty.join("notes.txt").exists());
        assert!(ahead.join("work.txt").exists());
        assert!(git::run(f.path(), &["rev-parse", "--verify", "raccoon/twin"]).is_ok());

        // Pushed is not merged: still kept.
        sh(&ahead, &["push", "-q", "origin", "raccoon/ahead-blue-elk"]);
        let leftovers = f.scan(&[]);
        assert!(find(&leftovers, LeftoverKind::Worktree, "ahead-blue-elk").unwrap().kept_because.is_some());
        assert!(find(&leftovers, LeftoverKind::Branch, "raccoon/twin").unwrap().kept_because.is_some());
    }

    #[test]
    fn a_squash_merged_worktree_and_its_branch_are_removable() {
        let f = Fixture::new();
        let wt = f.worktree("done-green-yak");
        sh(&wt, &["config", "user.email", "t@example.com"]);
        commit(&wt, "feature-1.txt");
        commit(&wt, "feature-2.txt");
        sh(&wt, &["push", "-q", "origin", "raccoon/done-green-yak"]);
        sh(f.path(), &["branch", "raccoon/same-work", "raccoon/done-green-yak"]);
        // Squash-merged on the remote, the way the project merges; this
        // clone has not fetched it. The scan does.
        let other = f.dir.path().join("other");
        sh(f.dir.path(), &["clone", "-q", f.dir.path().join("remote.git").to_str().unwrap(), other.to_str().unwrap()]);
        sh(&other, &["config", "user.email", "o@example.com"]);
        sh(&other, &["config", "user.name", "O"]);
        sh(&other, &["merge", "-q", "--squash", "origin/raccoon/done-green-yak"]);
        sh(&other, &["commit", "-q", "-m", "squashed (#1)"]);
        sh(&other, &["push", "-q", "origin", "main"]);

        let leftovers = f.scan(&[]);
        let worktree = find(&leftovers, LeftoverKind::Worktree, "done-green-yak").unwrap();
        assert_eq!(worktree.kept_because, None, "{worktree:?}");
        let branch = find(&leftovers, LeftoverKind::Branch, "raccoon/same-work").unwrap();
        assert_eq!(branch.kept_because, None);

        let removal = f.remove(&[], &[&worktree.id, &branch.id]);
        assert_eq!(removal.failed, vec![]);
        assert!(!wt.exists());
        assert!(git::run(f.path(), &["rev-parse", "--verify", "--quiet", "refs/heads/raccoon/same-work"]).is_err());
        // The worktree's own branch went with it: everything on it was
        // verified to be in main.
        assert!(git::run(f.path(), &["rev-parse", "--verify", "--quiet", "refs/heads/raccoon/done-green-yak"]).is_err());
        assert!(f.scan(&[]).is_empty());
    }

    #[test]
    fn a_worktree_that_changed_after_the_scan_is_not_removed() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let leftovers = f.scan(&[]);
        let worktree = find(&leftovers, LeftoverKind::Worktree, "quiet-amber-fox").unwrap();
        assert_eq!(worktree.kept_because, None, "{worktree:?}");
        std::fs::write(wt.join("new-work.txt"), "not saved anywhere\n").unwrap();
        let removal = f.remove(&[], &[&worktree.id]);
        assert_eq!(removal.removed, Vec::<String>::new());
        assert_eq!(removal.failed.len(), 1);
        assert!(wt.join("new-work.txt").exists());
    }

    #[test]
    fn a_branch_left_by_a_removed_squash_merged_worktree_is_offered() {
        let f = Fixture::new();
        let wt = f.worktree("done-green-yak");
        sh(&wt, &["config", "user.email", "t@example.com"]);
        commit(&wt, "feature.txt");
        sh(&wt, &["push", "-q", "origin", "raccoon/done-green-yak"]);
        let other = f.dir.path().join("other");
        sh(f.dir.path(), &["clone", "-q", f.dir.path().join("remote.git").to_str().unwrap(), other.to_str().unwrap()]);
        sh(&other, &["config", "user.email", "o@example.com"]);
        sh(&other, &["config", "user.name", "O"]);
        sh(&other, &["merge", "-q", "--squash", "origin/raccoon/done-green-yak"]);
        sh(&other, &["commit", "-q", "-m", "squashed (#1)"]);
        sh(&other, &["push", "-q", "origin", "main"]);
        // The remote branch is deleted after the merge, as GitHub does.
        sh(&other, &["push", "-q", "origin", "--delete", "raccoon/done-green-yak"]);
        sh(f.path(), &["fetch", "-q", "--prune", "origin"]);

        // An earlier delete took the directory and kept the branch: its
        // commits are in main only as a squash, so no other branch, remote
        // or tag has them. The scan offers it, on the strength of the merged
        // check.
        sh(f.path(), &["worktree", "remove", "--force", wt.to_str().unwrap()]);
        assert!(!wt.exists());
        let leftovers = f.scan(&[]);
        let branch = find(&leftovers, LeftoverKind::Branch, "raccoon/done-green-yak").expect("the branch is listed");
        assert_eq!(branch.kept_because, None);
        assert_eq!(f.remove(&[], &[&branch.id]).failed, vec![]);
        assert!(f.scan(&[]).is_empty());
    }

    #[test]
    fn nothing_is_removable_when_the_remote_cannot_be_reached() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        sh(f.path(), &["branch", "raccoon/idle", "main"]);
        sh(f.path(), &["remote", "set-url", "origin", f.dir.path().join("nowhere.git").to_str().unwrap()]);
        let leftovers = f.scan(&[]);
        assert_eq!(leftovers.len(), 2);
        for leftover in &leftovers {
            assert!(leftover.kept_because.as_deref().is_some_and(|reason| reason.starts_with("Not verified:")), "{leftover:?}");
        }
        let ids: Vec<&str> = leftovers.iter().map(|l| l.id.as_str()).collect();
        assert!(f.remove(&[], &ids).removed.is_empty());
        assert!(wt.join("a.txt").exists());
    }

    #[test]
    fn work_done_after_the_list_was_shown_is_still_protected() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let leftovers = f.scan(&[]);
        let id = find(&leftovers, LeftoverKind::Worktree, "quiet-amber-fox").unwrap().id.clone();
        std::fs::write(wt.join("late.txt"), "written after the scan").unwrap();
        let removal = f.remove(&[], &[&id]);
        assert!(removal.removed.is_empty());
        assert!(wt.join("late.txt").exists());
    }

    #[test]
    fn a_directory_that_is_not_a_worktree_is_kept_because_it_cannot_be_checked() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        std::fs::remove_file(wt.join(".git")).unwrap();
        std::fs::write(wt.join("unsaved.txt"), "x").unwrap();
        let stray = git::worktree_path(f.path(), "stray");
        std::fs::create_dir_all(&stray).unwrap();

        let leftovers = f.scan(&[]);
        for name in ["quiet-amber-fox", "stray"] {
            let item = find(&leftovers, LeftoverKind::Worktree, name).unwrap();
            assert!(item.kept_because.as_deref().unwrap().contains("cannot be checked"), "{name}");
            assert!(f.remove(&[], &[&item.id]).removed.is_empty());
        }
        assert!(wt.join("unsaved.txt").exists());
        assert!(stray.exists());
    }

    #[cfg(unix)]
    #[test]
    fn links_in_the_worktree_folder_are_not_leftovers() {
        let f = Fixture::new();
        f.worktree("quiet-amber-fox");
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep.txt"), "keep").unwrap();
        let link = git::worktree_path(f.path(), "link");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let to_project = git::worktree_path(f.path(), "project");
        std::os::unix::fs::symlink(f.path(), &to_project).unwrap();

        let leftovers = f.scan(&[]);
        assert!(find(&leftovers, LeftoverKind::Worktree, "link").is_none());
        assert!(find(&leftovers, LeftoverKind::Worktree, "project").is_none());
        for name in ["link", "project"] {
            let id = format!("worktree:{}:{name}", f.project.path);
            assert!(f.remove(&[], &[&id]).removed.is_empty());
        }
        assert!(outside.path().join("keep.txt").exists());
        assert!(f.path().join("a.txt").exists());
    }

    #[test]
    fn ids_that_name_anything_else_remove_nothing() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let project = &f.project.path;
        let hostile = [
            String::new(),
            "worktree::".to_string(),
            format!("worktree:{project}:"),
            format!("worktree:{project}:.."),
            format!("worktree:{project}:../.."),
            format!("worktree:{project}:quiet-amber-fox/../.."),
            format!("branch:{project}:main"),
            format!("branch:{project}:"),
            "claude:".to_string(),
            "claude:..".to_string(),
            "claude:../..".to_string(),
            "codex:/".to_string(),
        ];
        let ids: Vec<&str> = hostile.iter().map(String::as_str).collect();
        let removal = f.remove(&[], &ids);
        assert!(removal.removed.is_empty(), "{:?}", removal.removed);
        assert_eq!(removal.freed_bytes, 0);
        assert!(wt.join("a.txt").exists());
        assert!(f.path().join("a.txt").exists());
        assert!(git::run(f.path(), &["rev-parse", "--verify", "main"]).is_ok());
        assert!(f.claude_root.exists());
        assert!(f.dir.path().join("home/.claude").exists());
    }

    #[test]
    fn a_merged_branch_with_no_worktree_is_removable_and_others_are_left() {
        let f = Fixture::new();
        // Nothing of its own: points at a pushed commit.
        sh(f.path(), &["branch", "raccoon/done-green-yak", "main"]);
        // Not Raccoon's.
        sh(f.path(), &["branch", "feature/keep", "main"]);
        // Still checked out in a worktree made by hand.
        let by_hand = f.dir.path().join("by-hand");
        sh(f.path(), &["worktree", "add", "-q", "-b", "raccoon/in-use", by_hand.to_str().unwrap()]);
        // The branch a session is on.
        sh(f.path(), &["branch", "raccoon/session-branch", "main"]);
        let mut session = f.session(f.path(), vec![]);
        session.branch = Some("raccoon/session-branch".into());
        let sessions = [session];

        let leftovers = f.scan(&sessions);
        let branches: Vec<&str> = leftovers.iter().filter(|l| l.kind == LeftoverKind::Branch).map(|l| l.name.as_str()).collect();
        assert_eq!(branches, vec!["raccoon/done-green-yak"]);

        let id = leftovers[0].id.clone();
        let removal = f.remove(&sessions, &[&id, &format!("branch:{}:feature/keep", f.project.path), &format!("branch:{}:raccoon/in-use", f.project.path)]);
        assert_eq!(removal.removed, vec![id]);
        assert_eq!(removal.failed.len(), 2);
        for kept in ["feature/keep", "raccoon/in-use", "raccoon/session-branch", "main"] {
            assert!(git::run(f.path(), &["rev-parse", "--verify", kept]).is_ok(), "{kept}");
        }
        assert!(git::run(f.path(), &["rev-parse", "--verify", "raccoon/done-green-yak"]).is_err());
    }

    #[test]
    fn agent_data_for_a_gone_worktree_is_listed_and_everything_else_is_not() {
        let f = Fixture::new();
        let gone = git::worktree_path(f.path(), "gone");
        let live = f.worktree("live");
        let claude_gone = f.claude_transcript(&gone, CONV_A);
        let codex_gone = f.codex_rollout(&gone, CONV_A);
        // The worktree still exists; the project's own folder; a path the app does not manage.
        let claude_live = f.claude_transcript(&live, CONV_A);
        let claude_project = f.claude_transcript(f.path(), CONV_A);
        let unmanaged = f.dir.path().join("elsewhere/gone");
        let claude_unmanaged = f.claude_transcript(&unmanaged, CONV_A);
        let codex_unmanaged = f.codex_rollout(&unmanaged, CONV_B);

        let sessions = [f.session(&live, vec![])];
        let leftovers = f.scan(&sessions);
        let agent: Vec<&Leftover> = leftovers.iter().filter(|l| l.kind == LeftoverKind::AgentData).collect();
        assert_eq!(agent.len(), 2, "{agent:?}");
        assert!(agent.iter().all(|l| l.name == "gone" && l.size_bytes > 0 && l.kept_because.is_none()));

        let ids: Vec<&str> = agent.iter().map(|l| l.id.as_str()).collect();
        let removal = f.remove(&sessions, &ids);
        assert_eq!(removal.failed, vec![]);
        assert!(removal.freed_bytes > 0);
        assert!(!claude_gone.parent().unwrap().exists());
        assert!(!codex_gone.exists());
        for kept in [&claude_live, &claude_project, &claude_unmanaged, &codex_unmanaged] {
            assert!(kept.exists(), "{}", kept.display());
        }
    }

    #[test]
    fn only_conversations_are_removed_from_a_claude_folder() {
        let f = Fixture::new();
        let gone = git::worktree_path(f.path(), "gone");
        let transcript = f.claude_transcript(&gone, CONV_A);
        let folder = transcript.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(folder.join(CONV_A).join("subagents")).unwrap();
        std::fs::create_dir_all(folder.join("memory")).unwrap();
        std::fs::write(folder.join("memory/MEMORY.md"), "notes").unwrap();

        let leftovers = f.scan(&[]);
        let claude = leftovers.iter().find(|l| l.agent.as_deref() == Some("Claude")).unwrap();
        assert_eq!(claude.paths.len(), 2, "the transcript and its side folder: {:?}", claude.paths);
        assert_eq!(f.remove(&[], &[&claude.id]).failed, vec![]);
        assert!(!transcript.exists());
        assert!(!folder.join(CONV_A).exists());
        assert!(folder.join("memory/MEMORY.md").exists(), "what is not a conversation stays");
    }

    #[test]
    fn a_claude_folder_that_cannot_be_placed_is_left_alone() {
        let f = Fixture::new();
        let gone = git::worktree_path(f.path(), "gone");
        // One transcript says it was written somewhere else: the folder name is shared.
        let mine = f.claude_transcript(&gone, CONV_A);
        std::fs::write(mine.with_file_name(format!("{CONV_B}.jsonl")), format!("{}\n", serde_json::json!({ "cwd": "/somewhere/else" }))).unwrap();
        assert_eq!(f.scan(&[]), vec![]);

        // One transcript says nothing about where it was written.
        std::fs::write(mine.with_file_name(format!("{CONV_B}.jsonl")), "{\"type\":\"summary\"}\n").unwrap();
        assert_eq!(f.scan(&[]), vec![]);

        // A tab elsewhere has forked from the conversation and not started yet.
        std::fs::remove_file(mine.with_file_name(format!("{CONV_B}.jsonl"))).unwrap();
        assert_eq!(f.scan(&[]).len(), 1);
        let mut fork_tab = tab("claude", CONV_B);
        fork_tab.provider_session_id = None;
        fork_tab.fork_from = Some(CONV_A.into());
        let fork = f.session(f.path(), vec![fork_tab]);
        assert_eq!(f.scan(&[fork]), vec![]);
        assert!(mine.exists());
    }

    #[test]
    fn agent_data_a_session_still_refers_to_is_not_a_leftover() {
        let f = Fixture::new();
        let gone = git::worktree_path(f.path(), "gone");
        f.claude_transcript(&gone, CONV_A);
        f.codex_rollout(&gone, CONV_A);
        f.codex_rollout(&gone, CONV_B);

        // A session settled out of the worktree still resumes from the old folder.
        let mut settled = f.session(f.path(), vec![tab("claude", CONV_A)]);
        settled.removed_workspace = Some(index::RemovedWorkspace { path: gone.to_string_lossy().into_owned(), name: "gone".into(), branch: None });
        assert_eq!(f.scan(&[settled]), vec![]);

        // A session elsewhere that holds one of the Codex conversations keeps that one.
        let holder = f.session(f.path(), vec![tab("codex", CONV_A)]);
        let leftovers = f.scan(&[holder]);
        let codex = leftovers.iter().find(|l| l.agent.as_deref() == Some("Codex")).unwrap();
        assert_eq!(codex.paths.len(), 1);
        assert!(codex.paths[0].contains(CONV_B));
    }

    #[cfg(unix)]
    #[test]
    fn linked_agent_folders_are_never_listed() {
        let f = Fixture::new();
        let gone = git::worktree_path(f.path(), "gone");
        let target = tempfile::tempdir().unwrap();
        std::fs::write(target.path().join(format!("{CONV_A}.jsonl")), format!("{}\n", serde_json::json!({ "cwd": gone }))).unwrap();
        std::os::unix::fs::symlink(target.path(), f.claude_root.join(encoded_cwd(&gone.to_string_lossy()))).unwrap();
        let month = f.codex_home.join("sessions/2026/10");
        std::fs::create_dir_all(&month).unwrap();
        let rollouts = tempfile::tempdir().unwrap();
        std::fs::write(
            rollouts.path().join(format!("rollout-x-{CONV_A}.jsonl")),
            format!("{}\n", serde_json::json!({ "type": "session_meta", "payload": { "id": CONV_A, "cwd": gone } })),
        )
        .unwrap();
        std::os::unix::fs::symlink(rollouts.path(), month.join("03")).unwrap();

        assert_eq!(f.scan(&[]), vec![]);
        let removal = f.remove(&[], &[&format!("claude:{}", encoded_cwd(&gone.to_string_lossy())), &format!("codex:{}", gone.display())]);
        assert!(removal.removed.is_empty());
        assert!(target.path().join(format!("{CONV_A}.jsonl")).exists());
        assert!(rollouts.path().join(format!("rollout-x-{CONV_A}.jsonl")).exists());
    }

    #[test]
    fn the_real_entry_points_read_only_the_temporary_home() {
        let _home = crate::store::temp_home();
        assert_eq!(scan().unwrap(), vec![]);
        assert_eq!(remove(&["worktree:/:x".to_string()]).unwrap().removed, Vec::<String>::new());
    }
}
