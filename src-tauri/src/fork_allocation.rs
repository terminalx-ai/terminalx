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
    worktree: Option<(PathBuf, git::CreatedWorktree, String, Option<String>)>,
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

    pub fn rehome_claude(&mut self, projects: &Path, from: &str, to: &str, id: &str) -> Result<()> {
        if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') { return Ok(()); }
        let source = crate::harness::claude::transcript::locate_in(projects, from, id);
        let target = crate::harness::claude::transcript::transcript_in(projects, to, id);
        if source == target || !std::fs::symlink_metadata(&source).is_ok_and(|m| m.file_type().is_file())
            || std::fs::symlink_metadata(&target).is_ok() { return Ok(()); }
        self.write(&target, &std::fs::read(&source).with_context(|| format!("read {}", source.display()))?)
    }

    pub fn worktree(&mut self, project: &Path, worktree: git::CreatedWorktree, created_commit: String) {
        let copied = worktree.worktree_base.as_ref().and_then(|base| base.file_copy.as_ref()).map(|report| report.copied_files.as_slice()).unwrap_or_default();
        let snapshot = git::fork_worktree_snapshot(Path::new(&worktree.path), copied).ok().filter(|snapshot| snapshot.is_empty());
        self.worktree = Some((project.to_owned(), worktree, created_commit, snapshot));
    }

    /// Record only changes made by the checkpoint checkout, and only if the
    /// checkout was clean immediately before it. Other changes remain unowned.
    pub fn checkpoint(&mut self, tree: &str, index: &str, checkout: impl FnOnce() -> Result<()>) -> Result<()> {
        let Some((_, wt, _, expected)) = &mut self.worktree else { return checkout(); };
        let path = Path::new(&wt.path);
        let copied = wt.worktree_base.as_ref().and_then(|base| base.file_copy.as_ref()).map(|report| report.copied_files.as_slice()).unwrap_or_default();
        let before = git::fork_worktree_snapshot(path, copied)?;
        if expected.as_ref() != Some(&before) { anyhow::bail!("The new worktree contains other changes; its files were kept."); }
        let result = checkout();
        // A failed checkout may have made partial changes, which are not safe
        // to distinguish from another process's work.
        if result.is_err() { *expected = None; return result; }
        *expected = None;
        // The checkout owns only the requested tree and index. Do not adopt
        // an unrelated edit made while the checkout was running.
        git::run(path, &["diff", "--quiet", "--no-ext-diff", tree, "--"])
            .context("worktree changed during checkpoint checkout")?;
        let actual_index = git::run(path, &["write-tree"])?;
        anyhow::ensure!(actual_index.trim() == index, "index changed during checkpoint checkout");
        *expected = Some(git::fork_worktree_snapshot(path, copied)?);
        Ok(())
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
        if let Some((project, worktree, created_commit, snapshot)) = self.worktree {
            if let Err(e) = git::rollback_created_worktree(&project, &worktree, &created_commit, snapshot.as_deref()) {
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
    fn copied_ignored_files_allow_checkpoint_and_persistence_rollback() {
        let _home = crate::store::temp_home();
        let repo = repo();
        let state = tempfile::tempdir().unwrap();
        std::fs::write(repo.path().join(".git/info/exclude"), ".env\n").unwrap();
        std::fs::write(repo.path().join(".worktreeinclude"), ".env\n").unwrap();
        std::fs::write(repo.path().join(".env"), "private source").unwrap();
        std::fs::write(repo.path().join("source"), "checkpoint").unwrap();
        git::run(repo.path(), &["add", "source"]).unwrap();
        let tree = git::run(repo.path(), &["write-tree"]).unwrap().trim().to_string();
        git::run(repo.path(), &["reset", "--hard", "HEAD"]).unwrap();
        for stage in 0..=2 {
            let (wt, commit) = git::create_fork_worktree(repo.path(), "copy-test", Some("main")).unwrap();
            let path = PathBuf::from(&wt.path);
            let branch = wt.branch.clone();
            let report = wt.worktree_base.as_ref().unwrap().file_copy.as_ref().unwrap();
            assert_eq!(report.copied_files.len(), 1);
            assert!(serde_json::to_value(report).unwrap().get("copiedFiles").is_none());
            assert_eq!(std::fs::read_to_string(path.join(".env")).unwrap(), "private source");
            let mut allocation = ForkAllocation::default();
            allocation.worktree(repo.path(), wt, commit);
            allocation.checkpoint(&tree, &tree, || crate::checkpoints::check_out_turn(path.to_str().unwrap(), &tree, &tree)).unwrap();
            assert_eq!(std::fs::read_to_string(path.join("source")).unwrap(), "checkpoint");
            let mut writes = 0;
            let native = state.path().join("native");
            let session = state.path().join("session");
            let error = allocation.conversation_with(&native, b"native", &session, "tab", b"log", |allocation, path, bytes| {
                allocation.write(path, bytes)?;
                let current = writes;
                writes += 1;
                if current == stage { anyhow::bail!("injected failure"); }
                Ok(())
            }).and_then(|_| if stage == 2 { anyhow::bail!("injected index failure") } else { Ok(()) }).unwrap_err();
            let error = allocation.rollback(format!("{error:#}"));
            assert!(!error.contains("cleanup failed"), "{error}");
            assert!(!path.exists() && !git::branch_exists(repo.path(), &branch));
            assert!(!native.exists() && !session.exists());
            assert_eq!(std::fs::read_to_string(repo.path().join(".env")).unwrap(), "private source");
        }
    }

    #[test]
    fn copied_files_modified_or_extra_files_are_preserved() {
        let _home = crate::store::temp_home();
        let repo = repo();
        std::fs::write(repo.path().join(".git/info/exclude"), ".env\nother\n").unwrap();
        std::fs::write(repo.path().join(".worktreeinclude"), ".env\n").unwrap();
        std::fs::write(repo.path().join(".env"), "original").unwrap();
        for kind in ["modified", "extra", "removed", "replaced"] {
            if kind == "replaced" && !cfg!(any(unix, windows)) { continue; }
            let (wt, commit) = git::create_fork_worktree(repo.path(), kind, Some("main")).unwrap();
            let path = PathBuf::from(&wt.path);
            let mut allocation = ForkAllocation::default();
            allocation.worktree(repo.path(), wt, commit);
            match kind {
                "modified" => std::fs::write(path.join(".env"), "new work").unwrap(),
                "extra" => std::fs::write(path.join("other"), "new work").unwrap(),
                "replaced" => {
                    std::fs::rename(path.join(".env"), path.join("old-copy")).unwrap();
                    std::fs::write(path.join(".env"), "original").unwrap();
                    std::fs::remove_file(path.join("old-copy")).unwrap();
                }
                _ => std::fs::remove_file(path.join(".env")).unwrap(),
            }
            let error = allocation.rollback("index failed".into());
            assert!(error.contains("cleanup failed"), "{error}");
            assert!(path.exists());
        }
    }

    #[test]
    fn quick_fork_rehome_is_owned_and_existing_transcripts_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let source = crate::harness::claude::transcript::transcript_in(&projects, "/source", "parent");
        let target = crate::harness::claude::transcript::transcript_in(&projects, "/scratch", "parent");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, "original").unwrap();
        let mut allocation = ForkAllocation::default();
        allocation.rehome_claude(&projects, "/source", "/scratch", "parent").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
        assert_eq!(allocation.rollback("index failed".into()), "index failed");
        assert!(!target.exists());
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "original");
        std::fs::write(&target, "preexisting").unwrap();
        let mut allocation = ForkAllocation::default();
        allocation.rehome_claude(&projects, "/source", "/scratch", "parent").unwrap();
        allocation.rollback("index failed".into());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "preexisting");
    }

    #[test]
    fn rollback_keeps_staged_unstaged_and_untracked_work() {
        let _home = crate::store::temp_home();
        let repo = repo();
        for kind in ["staged", "unstaged", "untracked", "ignored"] {
            let (wt, commit) = git::create_fork_worktree(repo.path(), kind, Some("main")).unwrap();
            let path = PathBuf::from(&wt.path);
            let branch = wt.branch.clone();
            let mut allocation = ForkAllocation::default();
            allocation.worktree(repo.path(), wt, commit);
            if kind == "untracked" || kind == "ignored" {
                if kind == "ignored" { std::fs::write(repo.path().join(".git/info/exclude"), "ignored-file\n").unwrap(); }
                std::fs::write(path.join(if kind == "ignored" { "ignored-file" } else { "new-file" }), "keep").unwrap();
            } else {
                std::fs::write(path.join("source"), "keep").unwrap();
                if kind == "staged" { git::run(&path, &["add", "source"]).unwrap(); }
            }
            let error = allocation.rollback("index failed".into());
            assert!(error.contains("cleanup failed"), "{kind}: {error}");
            assert!(path.exists() && git::branch_exists(repo.path(), &branch));
        }
    }

    #[cfg(unix)]
    #[test]
    fn checkout_hook_work_is_kept_and_checkpoint_does_not_overwrite_it() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let repo = repo();
        let hook = repo.path().join(".git/hooks/post-checkout");
        std::fs::write(&hook, "#!/bin/sh\nprintf hook > source\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (wt, commit) = git::create_fork_worktree(repo.path(), "hook", Some("main")).unwrap();
        let path = PathBuf::from(&wt.path);
        let mut allocation = ForkAllocation::default();
        allocation.worktree(repo.path(), wt, commit);
        assert!(allocation.checkpoint("HEAD", "HEAD", || { std::fs::write(path.join("source"), "checkpoint")?; Ok(()) }).is_err());
        assert!(allocation.rollback("index failed".into()).contains("cleanup failed"));
        assert_eq!(std::fs::read_to_string(path.join("source")).unwrap(), "hook");
    }

    #[cfg(unix)]
    #[test]
    fn failed_checkout_hook_retains_its_changes() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let repo = repo();
        let hook = repo.path().join(".git/hooks/post-checkout");
        std::fs::write(&hook, "#!/bin/sh\nprintf hook > source\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = git::create_fork_worktree(repo.path(), "hook-failure", Some("main")).unwrap_err();
        assert!(format!("{error:#}").contains("cleanup failed"));
        let path = git::worktree_path(repo.path(), "hook-failure");
        assert_eq!(std::fs::read_to_string(path.join("source")).unwrap(), "hook");
    }

    #[test]
    fn rollback_removes_unchanged_checkpoint_but_keeps_later_edits() {
        let _home = crate::store::temp_home();
        let repo = repo();
        std::fs::write(repo.path().join("source"), "checkpoint").unwrap();
        git::run(repo.path(), &["add", "source"]).unwrap();
        let tree = git::run(repo.path(), &["write-tree"]).unwrap().trim().to_string();
        git::run(repo.path(), &["reset", "--hard", "HEAD"]).unwrap();
        let base_tree = git::run(repo.path(), &["rev-parse", "HEAD^{tree}"]).unwrap().trim().to_string();
        for later in [false, true] {
            let name = if later { "later" } else { "checkpoint" };
            let (wt, commit) = git::create_fork_worktree(repo.path(), name, Some("main")).unwrap();
            let path = PathBuf::from(&wt.path);
            let mut allocation = ForkAllocation::default();
            allocation.worktree(repo.path(), wt, commit);
            let index = if later { &base_tree } else { &tree };
            allocation.checkpoint(&tree, index, || crate::checkpoints::check_out_turn(path.to_str().unwrap(), &tree, index)).unwrap();
            if later { std::fs::write(path.join("source"), "later work").unwrap(); }
            let error = allocation.rollback("index failed".into());
            assert_eq!(path.exists(), later, "{error}");
            if later { assert!(error.contains("cleanup failed")); }
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
