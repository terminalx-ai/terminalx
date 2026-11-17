//! `machine/8` (PRO-405): a machine session's Files, editor and file search
//! rooted at the session's own worktree, wherever Settings puts worktrees.
//!
//! A `fs.*` call names the session (`sessionId`) instead of a project. The
//! runtime reads that session from its own index, finds its project among
//! the machine's, and serves the session's folder as a root of its own when
//! it is the project's folder, a folder inside it, or one of the project's own
//! git worktrees (`machine::worktrees`). Anything else is `path_forbidden`:
//! a worktree made by hand somewhere else, another project's worktree, or a
//! folder that is no worktree at all. The client never sends a path of the
//! machine; every path in the calls is relative to that root.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::machine::{self, Projects, ServedProject};
use super::protocol::RpcError;
use crate::store::index::SessionEntry;

/// How long a worktree found to be its project's is served before it is
/// looked up again: one removed meanwhile is refused within this.
const VERIFIED_FOR: Duration = Duration::from_secs(2);

/// Where `cwd` (canonical) stands in the project rooted at `root`
/// (canonical): its folder or a folder inside it, one of its worktrees
/// outside it, or neither.
fn belongs(root: &Path, cwd: &Path) -> bool {
    if cwd.starts_with(root) {
        return true;
    }
    crate::git::is_repo(root) && machine::worktrees(root).iter().any(|worktree| worktree == cwd)
}

/// The served root of `session`'s folder (`machine/8`): its project itself
/// when it runs in the project's folder, else its worktree as a root of its
/// own. The session must be one of this machine's projects', and its folder
/// one of that project's worktrees.
pub(super) fn served_for(projects: &Projects, session: &SessionEntry) -> Result<Arc<ServedProject>, RpcError> {
    if session.worktree_removed {
        return Err(RpcError::not_found("this session's worktree was removed"));
    }
    let project = projects.get(&machine::project_id(&session.project_path))?;
    let cwd = std::fs::canonicalize(&session.cwd).map_err(|_| RpcError::not_found("the folder of this session is gone"))?;
    if cwd == project.root {
        return Ok(project);
    }
    if let Some((served, at)) = projects.worktrees.lock().unwrap().get(&cwd) {
        if served.id == project.id && at.elapsed() < VERIFIED_FOR {
            return Ok(served.clone());
        }
    }
    // Read outside the lock: it runs git.
    let own = belongs(&project.root, &cwd);
    let mut worktrees = projects.worktrees.lock().unwrap();
    if !own {
        worktrees.remove(&cwd);
        return Err(RpcError::new("path_forbidden", "this session's folder is not its project's folder or one of the project's worktrees"));
    }
    let id = project.id.clone().ok_or_else(|| RpcError::internal("a machine project has an id"))?;
    let entry = worktrees.entry(cwd.clone()).or_insert_with(|| (Arc::new(ServedProject::session_worktree(id.clone(), cwd.clone())), Instant::now()));
    if entry.0.id.as_deref() != Some(id.as_str()) {
        // The folder now belongs to another project (removed and made again): nothing of the old one is kept.
        entry.0 = Arc::new(ServedProject::session_worktree(id, cwd));
    }
    entry.1 = Instant::now();
    Ok(entry.0.clone())
}

#[cfg(test)]
#[path = "machine_files_tests.rs"]
mod tests;
