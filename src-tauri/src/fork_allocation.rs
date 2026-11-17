//! Resources owned by an unpublished session fork.  This is deliberately
//! separate from deletion of a session that has already been published.
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::git;

#[derive(Default)]
pub(crate) struct ForkAllocation {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    worktree: Option<(PathBuf, git::CreatedWorktree, String)>,
}

impl ForkAllocation {
    pub fn directory(&mut self, path: &Path) -> Result<()> {
        std::fs::create_dir(path).with_context(|| format!("create {}", path.display()))?;
        self.directories.push(path.to_owned());
        Ok(())
    }

    pub fn write(&mut self, path: &Path, bytes: &[u8]) -> Result<()> {
        let parent = path.parent().context("no parent directory")?;
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).with_context(|| format!("create {}", path.display()))?;
        self.files.push(path.to_owned());
        file.write_all(bytes).with_context(|| format!("write {}", path.display()))?;
        file.sync_all().with_context(|| format!("sync {}", path.display()))?;
        Ok(())
    }

    pub fn conversation(&mut self, native: &Path, native_bytes: &[u8], session_dir: &Path, tab_id: &str, log: &[u8]) -> Result<()> {
        self.conversation_with(native, native_bytes, session_dir, tab_id, log, |allocation, path, bytes| allocation.write(path, bytes))
    }

    fn conversation_with(&mut self, native: &Path, native_bytes: &[u8], session_dir: &Path, tab_id: &str, log: &[u8],
        mut write: impl FnMut(&mut Self, &Path, &[u8]) -> Result<()>) -> Result<()> {
        write(self, native, native_bytes)?;
        self.directory(session_dir)?;
        write(self, &session_dir.join(format!("{tab_id}.jsonl")), log)
    }

    pub fn worktree(&mut self, project: &Path, worktree: git::CreatedWorktree, created_commit: String) {
        self.worktree = Some((project.to_owned(), worktree, created_commit));
    }

    /// Commit means the index now owns these resources.
    pub fn commit(mut self) {
        self.files.clear();
        self.directories.clear();
        self.worktree = None;
    }

    pub fn rollback(self, error: String) -> String {
        let mut failures = Vec::new();
        for path in self.files.iter().rev() {
            if let Err(e) = std::fs::remove_file(path) {
                if e.kind() != std::io::ErrorKind::NotFound { failures.push(format!("remove {}: {e}", path.display())); }
            }
        }
        for path in self.directories.iter().rev() {
            if let Err(e) = std::fs::remove_dir_all(path) {
                if e.kind() != std::io::ErrorKind::NotFound { failures.push(format!("remove {}: {e}", path.display())); }
            }
        }
        if let Some((project, worktree, created_commit)) = self.worktree {
            if let Err(e) = git::rollback_created_worktree(&project, &worktree, &created_commit) {
                failures.push(format!("remove worktree {} and branch {}: {e:#}", worktree.path, worktree.branch));
            }
        }
        if failures.is_empty() { error } else { format!("{error}; cleanup failed: {}", failures.join("; ")) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git::run(p, &["init", "-q", "-b", "main"]).unwrap();
        git::run(p, &["config", "user.email", "test@example.com"]).unwrap();
        git::run(p, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(p.join("source"), "original").unwrap();
        git::run(p, &["add", "source"]).unwrap();
        git::run(p, &["commit", "-qm", "initial"]).unwrap();
        dir
    }

    #[test]
    fn persistence_failures_rollback_only_the_new_fork() {
        let _home = crate::store::temp_home();
        let repo = repo();
        let state = tempfile::tempdir().unwrap();
        let native = state.path().join("native.jsonl");
        let session = state.path().join("new-session");
        let existing = state.path().join("existing");
        std::fs::write(&existing, "keep").unwrap();
        let source = crate::store::index::SessionEntry {
            id: "source".into(), kind: crate::store::index::SessionKind::Project,
            project_path: repo.path().to_string_lossy().into_owned(), cwd: repo.path().to_string_lossy().into_owned(),
            worktree_name: None, branch: Some("main".into()), base_ref: None, worktree_base: None,
            worktree_removed: false, removed_workspace: None, issue: None, issue_work: Default::default(),
            automation: None, title: "source".into(), created: "now".into(), modified: "now".into(),
            archived: false, archive: Default::default(), pinned: false, manual_status: Default::default(),
            tabs: vec![], active_tab: None, link: None, parent: None, unknown: Default::default(),
        };
        crate::store::index::save(&[source]).unwrap();
        let index_path = crate::store::sessions_dir().unwrap().join("index.json");
        let original_index = std::fs::read(&index_path).unwrap();
        let original_log = crate::store::log_path("source", "tab").unwrap();
        std::fs::write(&original_log, "source transcript").unwrap();
        for fail_at in 0..=2 {
            let (wt, created_commit) = git::create_fork_worktree(repo.path(), "fork-test", Some("main")).unwrap();
            let wt_path = PathBuf::from(&wt.path);
            let branch = wt.branch.clone();
            let mut allocation = ForkAllocation::default();
            allocation.worktree(repo.path(), wt, created_commit);
            let mut writes = 0;
            let result = allocation.conversation_with(&native, b"native", &session, "tab", b"log", |allocation, path, bytes| {
                allocation.write(path, bytes)?;
                let current = writes;
                writes += 1;
                if current == fail_at { anyhow::bail!("injected persistence failure"); }
                Ok(())
            }).and_then(|_| {
                if fail_at != 2 { return Ok(()); }
                // Block the atomic index temporary file after both transcripts
                // exist, exercising the real index persistence path.
                let sessions = crate::store::sessions_dir()?;
                let blocker = sessions.join("index.json").with_extension(format!("tmp.{}", std::process::id()));
                std::fs::create_dir(&blocker)?;
                let result = crate::store::index::update(|_| Ok(()));
                std::fs::remove_dir(&blocker)?;
                result
            });
            let error = allocation.rollback(format!("{:#}", result.unwrap_err()));
            if fail_at != 2 { assert!(error.contains("injected"), "{error}"); }
            assert!(!error.contains("cleanup failed"), "{error}");
            assert!(!wt_path.exists());
            assert!(!git::branch_exists(repo.path(), &branch));
            assert!(!native.exists());
            assert!(!session.exists());
            assert_eq!(std::fs::read_to_string(&existing).unwrap(), "keep");
            assert_eq!(std::fs::read(&index_path).unwrap(), original_index);
            assert_eq!(std::fs::read_to_string(&original_log).unwrap(), "source transcript");
            assert_eq!(std::fs::read_to_string(repo.path().join("source")).unwrap(), "original");
            assert!(git::branch_exists(repo.path(), "main"));
        }
    }

    #[test]
    fn existing_branch_is_never_removed_on_allocation_failure() {
        let _home = crate::store::temp_home();
        let repo = repo();
        let branch = git::worktree_branch_for(repo.path(), "fork-test").unwrap();
        git::run(repo.path(), &["branch", &branch]).unwrap();
        let original = git::run(repo.path(), &["rev-parse", &branch]).unwrap();
        assert!(git::create_fork_worktree(repo.path(), "fork-test", Some("main")).is_err());
        assert_eq!(git::run(repo.path(), &["rev-parse", &branch]).unwrap(), original);
        assert!(!git::worktree_path(repo.path(), "fork-test").exists());
    }

    #[cfg(unix)]
    #[test]
    fn failed_checkout_hook_rolls_back_the_allocation() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let repo = repo();
        let hook = repo.path().join(".git/hooks/post-checkout");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = git::create_fork_worktree(repo.path(), "fork-test", Some("main")).unwrap_err();
        assert!(!format!("{error:#}").contains("cleanup failed"), "{error:#}");
        assert!(!git::worktree_path(repo.path(), "fork-test").exists());
        let branch = git::worktree_branch_for(repo.path(), "fork-test").unwrap();
        assert!(!git::branch_exists(repo.path(), &branch));
        assert_eq!(std::fs::read_to_string(repo.path().join("source")).unwrap(), "original");
    }

    #[test]
    fn existing_session_directory_is_not_claimed() {
        let _home = crate::store::temp_home();
        let repo = repo();
        let state = tempfile::tempdir().unwrap();
        let native = state.path().join("native");
        let session = state.path().join("session");
        std::fs::create_dir(&session).unwrap();
        std::fs::write(session.join("existing"), "keep").unwrap();
        let (wt, created_commit) = git::create_fork_worktree(repo.path(), "fork-test", Some("main")).unwrap();
        let path = PathBuf::from(&wt.path);
        let branch = wt.branch.clone();
        let mut allocation = ForkAllocation::default();
        allocation.worktree(repo.path(), wt, created_commit);
        let failure = allocation.conversation(&native, b"new", &session, "tab", b"log").unwrap_err();
        let error = allocation.rollback(format!("{failure:#}"));
        assert!(!error.contains("cleanup failed"), "{error}");
        assert_eq!(std::fs::read_to_string(session.join("existing")).unwrap(), "keep");
        assert!(!native.exists() && !path.exists());
        assert!(!git::branch_exists(repo.path(), &branch));
    }

    #[test]
    fn committed_fork_keeps_its_resources() {
        let _home = crate::store::temp_home();
        let repo = repo();
        let state = tempfile::tempdir().unwrap();
        let (wt, created_commit) = git::create_fork_worktree(repo.path(), "fork-test", Some("main")).unwrap();
        let path = PathBuf::from(&wt.path);
        let branch = wt.branch.clone();
        let mut allocation = ForkAllocation::default();
        allocation.worktree(repo.path(), wt, created_commit);
        let native = state.path().join("native");
        let session = state.path().join("session");
        allocation.conversation(&native, b"native", &session, "tab", b"log").unwrap();
        allocation.commit();
        assert_eq!(std::fs::read(native).unwrap(), b"native");
        assert_eq!(std::fs::read(session.join("tab.jsonl")).unwrap(), b"log");
        assert!(path.exists() && git::branch_exists(repo.path(), &branch));
    }

    #[test]
    fn collisions_are_preserved_and_cleanup_errors_are_reported() {
        let _home = crate::store::temp_home();
        let repo = repo();
        let state = tempfile::tempdir().unwrap();
        let native = state.path().join("native");
        std::fs::write(&native, "existing").unwrap();
        let (wt, created_commit) = git::create_fork_worktree(repo.path(), "fork-test", Some("main")).unwrap();
        let path = PathBuf::from(&wt.path);
        let branch = wt.branch.clone();
        let mut allocation = ForkAllocation::default();
        allocation.worktree(repo.path(), wt, created_commit);
        let failure = allocation.conversation(&native, b"new", &state.path().join("session"), "tab", b"log").unwrap_err();
        // Change the branch to ensure rollback refuses to delete someone else's work.
        std::fs::write(path.join("source"), "changed").unwrap();
        git::run(&path, &["add", "source"]).unwrap();
        git::run(&path, &["commit", "-qm", "new work"]).unwrap();
        let error = allocation.rollback(format!("{failure:#}"));
        assert!(error.contains("cleanup failed") && error.contains("moved"), "{error}");
        assert_eq!(std::fs::read_to_string(native).unwrap(), "existing");
        assert!(path.exists() && git::branch_exists(repo.path(), &branch));
    }
}
