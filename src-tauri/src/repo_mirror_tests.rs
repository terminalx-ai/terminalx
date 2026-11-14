use super::*;

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
    source: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let source = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        for (key, value) in [
            ("user.name", "Mirror test"),
            ("user.email", "mirror@example.test"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&root, &["config", key, value]).unwrap();
        }
        fs::write(root.join("file.txt"), "original\n").unwrap();
        fs::write(root.join("gone.txt"), "restore me\n").unwrap();
        fs::write(root.join(".gitignore"), "ignored\n").unwrap();
        git(&root, &["add", "."]).unwrap();
        git(&root, &["commit", "-m", "base"]).unwrap();
        git(&root, &["worktree", "add", "-b", "feature", source.to_str().unwrap()]).unwrap();
        Self {
            root: fs::canonicalize(root).unwrap(),
            source: fs::canonicalize(source).unwrap(),
            _temp: temp,
        }
    }
    fn start(&self) -> Status {
        start(&self.root, &self.source, true).unwrap()
    }
    fn tick(&self) -> Result<()> {
        running(&self.root).unwrap().lock().unwrap().sync()
    }
    fn crash(&self) {
        let removed = mirrors().lock().unwrap().remove(&self.root);
        if let Some(handle) = removed {
            let mut mirror = handle.lock().unwrap();
            mirror.stopped = true;
            mirror.lease.take();
        }
    }
    fn clean(&self) {
        assert!(git(&self.root, &["status", "--porcelain", "--untracked-files=all"]).unwrap().is_empty());
        assert!(!self.root.join(".git").join(RECORD).exists());
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        self.crash();
    }
}

#[test]
fn committed_staged_unstaged_untracked_binary_and_deleted_files_round_trip() {
    let r = Repo::new();
    let original_head = head(&r.root).unwrap();
    let original_index = fs::read(r.root.join(".git/index")).unwrap();
    fs::write(r.source.join("file.txt"), "committed\n").unwrap();
    git(&r.source, &["commit", "-am", "workspace commit"]).unwrap();
    fs::write(r.source.join("file.txt"), "staged\n").unwrap();
    git(&r.source, &["add", "file.txt"]).unwrap();
    fs::write(r.source.join("file.txt"), "unstaged\n").unwrap();
    fs::remove_file(r.source.join("gone.txt")).unwrap();
    fs::write(r.source.join("new\nfile.bin"), [0, 255, 13, 10, 0]).unwrap();
    assert!(r.start().active);
    assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "unstaged\n");
    assert_eq!(fs::read(r.root.join("new\nfile.bin")).unwrap(), [0, 255, 13, 10, 0]);
    assert!(!r.root.join("gone.txt").exists());
    assert_eq!(head(&r.root).unwrap(), original_head);
    assert_eq!(fs::read(r.root.join(".git/index")).unwrap(), original_index);
    fs::rename(r.source.join("new\nfile.bin"), r.source.join("renamed.bin")).unwrap();
    fs::write(r.source.join("file.txt"), "later\n").unwrap();
    r.tick().unwrap();
    assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "later\n");
    assert!(!r.root.join("new\nfile.bin").exists());
    stop(&r.root).unwrap();
    r.clean();
    assert_eq!(head(&r.root).unwrap(), original_head);
    assert_eq!(branch(&r.root).unwrap(), "refs/heads/main");
    assert_eq!(fs::read(r.root.join(".git/index")).unwrap(), original_index);
    assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "original\n");
    assert_eq!(fs::read_to_string(r.root.join("gone.txt")).unwrap(), "restore me\n");
    assert_eq!(fs::read_to_string(r.source.join("file.txt")).unwrap(), "later\n");
}

#[test]
fn refuses_dirty_roots_and_requires_confirmation_without_writing() {
    let r = Repo::new();
    assert!(start(&r.root, &r.source, false).unwrap_err().to_string().contains("Confirm"));
    for staged in [false, true] {
        fs::write(r.root.join("file.txt"), "my work\n").unwrap();
        if staged {
            git(&r.root, &["add", "file.txt"]).unwrap();
        }
        assert!(start(&r.root, &r.source, true).unwrap_err().to_string().contains("uncommitted"));
        assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "my work\n");
    }
    git(&r.root, &["restore", "--staged", "file.txt"]).unwrap();
    fs::write(r.root.join("file.txt"), "original\n").unwrap();
    fs::write(r.root.join("untracked"), "keep").unwrap();
    assert!(start(&r.root, &r.source, true).unwrap_err().to_string().contains("untracked"));
    assert!(!r.root.join(".git").join(RECORD).exists());
}

#[test]
fn external_edits_pause_sync_and_block_stop_until_saved() {
    let r = Repo::new();
    fs::write(r.source.join("file.txt"), "workspace\n").unwrap();
    assert!(r.start().active);
    fs::write(r.root.join("file.txt"), "my root edit\n").unwrap();
    fs::write(r.source.join("file.txt"), "next\n").unwrap();
    assert!(r.tick().unwrap_err().to_string().contains("edited outside"));
    assert!(stop(&r.root).unwrap_err().to_string().contains("edited outside"));
    assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "my root edit\n");
    assert!(!status(&r.root).unwrap().active);
    fs::write(r.root.join("file.txt"), "workspace\n").unwrap();
    stop(&r.root).unwrap();
    r.clean();
}

#[test]
fn staged_changes_and_changed_head_are_never_cleaned_up() {
    let r = Repo::new();
    fs::write(r.source.join("file.txt"), "workspace\n").unwrap();
    assert!(r.start().active);
    git(&r.root, &["add", "file.txt"]).unwrap();
    assert!(stop(&r.root).unwrap_err().to_string().contains("staged changes"));
    git(&r.root, &["restore", "--staged", "file.txt"]).unwrap();
    git(&r.root, &["symbolic-ref", "HEAD", "refs/heads/feature"]).unwrap();
    assert!(stop(&r.root).unwrap_err().to_string().contains("HEAD or branch changed"));
    git(&r.root, &["symbolic-ref", "HEAD", "refs/heads/main"]).unwrap();
    stop(&r.root).unwrap();
    r.clean();
}

#[test]
fn ignored_files_are_preserved_and_collisions_refused() {
    let r = Repo::new();
    fs::create_dir(r.root.join("ignored")).unwrap();
    fs::write(r.root.join("ignored/local"), "keep me").unwrap();
    fs::create_dir(r.source.join("ignored")).unwrap();
    fs::write(r.source.join("ignored/local"), "workspace").unwrap();
    fs::write(r.source.join("ignored/forced"), "staged despite ignore").unwrap();
    git(&r.source, &["add", "-f", "ignored/forced"]).unwrap();
    assert!(r.start().active);
    assert_eq!(fs::read_to_string(r.root.join("ignored/local")).unwrap(), "keep me");
    assert_eq!(fs::read_to_string(r.root.join("ignored/forced")).unwrap(), "staged despite ignore");
    stop(&r.root).unwrap();
    assert_eq!(fs::read_to_string(r.root.join("ignored/local")).unwrap(), "keep me");
    assert!(!r.root.join("ignored/forced").exists());
    git(&r.source, &["add", "-f", "ignored/local"]).unwrap();
    let blocked = r.start();
    assert!(!blocked.active);
    assert!(blocked.error.is_some());
    assert_eq!(fs::read_to_string(r.root.join("ignored/local")).unwrap(), "keep me");
    stop(&r.root).unwrap();
    r.clean();
}

#[test]
fn restart_keeps_recovery_and_only_one_worktree_can_mirror() {
    let r = Repo::new();
    fs::write(r.source.join("file.txt"), "workspace\n").unwrap();
    assert!(r.start().active);
    assert!(start(&r.root, &r.source, true).is_err());
    assert!(lease(&r.root.join(".git")).is_err());
    r.crash();
    let interrupted = status(&r.root).unwrap();
    assert!(!interrupted.active && interrupted.source.is_some());
    assert!(start(&r.root, &r.source, true).unwrap_err().to_string().contains("cleanup"));
    // Cleanup uses the journal, not the source: it works after source removal.
    fs::remove_dir_all(&r.source).unwrap();
    stop(&r.root).unwrap();
    r.clean();
}

#[test]
fn pending_apply_is_recoverable_on_either_side_of_the_write() {
    for completed in [false, true] {
        let r = Repo::new();
        assert!(r.start().active);
        fs::create_dir(r.source.join("ignored")).unwrap();
        fs::write(r.source.join("ignored/forced"), "staged").unwrap();
        git(&r.source, &["add", "-f", "ignored/forced"]).unwrap();
        let target = snapshot(&r.source, "INDEX").unwrap();
        {
            let running = running(&r.root).unwrap();
            let mut mirror = running.lock().unwrap();
            let before = mirror.journal.applied.clone();
            if completed {
                mirror.apply(&target).unwrap();
            }
            mirror.journal.applied = before;
            mirror.journal.pending = Some(target);
            mirror.save().unwrap();
        }
        r.crash();
        stop(&r.root).unwrap();
        assert!(!r.root.join("ignored/forced").exists());
        r.clean();
    }
}

#[test]
fn refuses_other_repositories_root_itself_sparse_and_assume_unchanged() {
    let r = Repo::new();
    let other = Repo::new();
    assert!(start(&r.root, &r.root, true).is_err());
    assert!(start(&r.root, &other.source, true).is_err());
    for flag in ["--assume-unchanged", "--skip-worktree"] {
        git(&r.root, &["update-index", flag, "file.txt"]).unwrap();
        fs::write(r.root.join("file.txt"), "hidden edits\n").unwrap();
        assert!(start(&r.root, &r.source, true).is_err());
        assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "hidden edits\n");
        git(&r.root, &["update-index", "--no-assume-unchanged", "--no-skip-worktree", "file.txt"]).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn symlinks_and_executable_modes_round_trip_without_following_links() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let r = Repo::new();
    let external = r._temp.path().join("external");
    fs::write(&external, "keep").unwrap();
    symlink(&external, r.source.join("link")).unwrap();
    fs::set_permissions(r.source.join("file.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(r.start().active);
    assert_eq!(fs::read_link(r.root.join("link")).unwrap(), external);
    assert_ne!(fs::metadata(r.root.join("file.txt")).unwrap().permissions().mode() & 0o111, 0);
    stop(&r.root).unwrap();
    assert_eq!(fs::read_to_string(external).unwrap(), "keep");
    assert!(!r.root.join("link").exists());
    r.clean();
}

#[test]
fn background_worker_syncs_without_a_view_poll() {
    let r = Repo::new();
    assert!(r.start().active);
    fs::write(r.source.join("file.txt"), "live\n").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    // Applying a patch can briefly remove the file before recreating it.
    while !fs::read_to_string(r.root.join("file.txt")).is_ok_and(|content| content == "live\n") {
        assert!(std::time::Instant::now() < deadline, "worker did not mirror within a few seconds");
        std::thread::sleep(Duration::from_millis(50));
    }
    stop(&r.root).unwrap();
    r.clean();
}

#[test]
fn interrupted_partial_patch_can_be_stopped_but_a_third_version_is_kept() {
    let r = Repo::new();
    assert!(r.start().active);
    fs::write(r.source.join("file.txt"), "next file\n").unwrap();
    fs::write(r.source.join("gone.txt"), "next gone\n").unwrap();
    let target = snapshot(&r.source, "INDEX").unwrap();
    {
        let running = running(&r.root).unwrap();
        let mut mirror = running.lock().unwrap();
        mirror.journal.pending = Some(target);
        mirror.save().unwrap();
    }
    r.crash();
    fs::write(r.root.join("file.txt"), "third version\n").unwrap();
    assert!(stop(&r.root).is_err());
    assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "third version\n");
    fs::write(r.root.join("file.txt"), "next file\n").unwrap();
    stop(&r.root).unwrap();
    r.clean();
}

#[test]
fn line_endings_follow_git_attributes_and_return_to_a_clean_tree() {
    let r = Repo::new();
    for cwd in [&r.root, &r.source] {
        fs::write(cwd.join(".gitattributes"), "*.txt text eol=crlf\n").unwrap();
        git(cwd, &["add", ".gitattributes"]).unwrap();
        git(cwd, &["commit", "-m", "line endings"]).unwrap();
    }
    // Git writes the root's CRLF copy, as a checkout under these attributes
    // has it. Rewritten by hand, its index entry predates the attribute and
    // `git status` reports it modified, so the mirror would rightly refuse.
    fs::remove_file(r.root.join("file.txt")).unwrap();
    git(&r.root, &["checkout", "--", "file.txt"]).unwrap();
    assert_eq!(fs::read(r.root.join("file.txt")).unwrap(), b"original\r\n");
    fs::write(r.source.join("file.txt"), b"workspace\r\n").unwrap();
    assert!(r.start().active);
    assert_eq!(fs::read(r.root.join("file.txt")).unwrap(), b"workspace\r\n");
    stop(&r.root).unwrap();
    assert_eq!(fs::read(r.root.join("file.txt")).unwrap(), b"original\r\n");
    r.clean();
}

#[test]
fn a_workspace_index_lock_defers_a_tick_and_syncs_afterwards() {
    let r = Repo::new();
    assert!(r.start().active);
    let own = PathBuf::from(git(&r.source, &["rev-parse", "--absolute-git-dir"]).unwrap());
    fs::write(own.join("index.lock"), "").unwrap();
    fs::write(r.source.join("file.txt"), "next\n").unwrap();
    r.tick().unwrap();
    assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "original\n");
    fs::remove_file(own.join("index.lock")).unwrap();
    r.tick().unwrap();
    assert_eq!(fs::read_to_string(r.root.join("file.txt")).unwrap(), "next\n");
    stop(&r.root).unwrap();
    r.clean();
}

#[test]
fn stop_recognizes_a_root_the_owner_already_saved_with_stash() {
    let r = Repo::new();
    fs::write(r.source.join("file.txt"), "workspace\n").unwrap();
    assert!(r.start().active);
    fs::write(r.root.join("file.txt"), "my root edit\n").unwrap();
    assert!(stop(&r.root).is_err());
    git(&r.root, &["stash", "push", "--include-untracked", "-m", "saved root work"]).unwrap();
    stop(&r.root).unwrap();
    r.clean();
    assert_eq!(git(&r.root, &["show", "stash@{0}:file.txt"]).unwrap(), "my root edit");
}

#[cfg(unix)]
#[test]
fn an_ignored_symlink_parent_cannot_redirect_mirror_writes() {
    let r = Repo::new();
    let outside = r._temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), "outside data").unwrap();
    std::os::unix::fs::symlink(&outside, r.root.join("ignored")).unwrap();
    fs::create_dir(r.source.join("ignored")).unwrap();
    fs::write(r.source.join("ignored/new"), "workspace").unwrap();
    git(&r.source, &["add", "-f", "ignored/new"]).unwrap();
    assert!(!r.start().active);
    assert!(!outside.join("new").exists());
    assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "outside data");
    stop(&r.root).unwrap();
    r.clean();
}

#[test]
fn submodules_are_refused_before_creating_a_recovery_record() {
    let r = Repo::new();
    let cacheinfo = format!("160000,{},nested", head(&r.source).unwrap());
    git(&r.source, &["update-index", "--add", "--cacheinfo", &cacheinfo]).unwrap();
    assert!(start(&r.root, &r.source, true).unwrap_err().to_string().contains("submodules"));
    r.clean();
}
