use super::*;

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git::run(dir.path(), &["init", "-q", "-b", "main"]).unwrap();
    git::run(dir.path(), &["config", "user.name", "Test"]).unwrap();
    git::run(dir.path(), &["config", "user.email", "test@example.com"]).unwrap();
    write(dir.path(), ".gitignore", ".env*\nconfig/local/\ncache/\n");
    write(dir.path(), "tracked.txt", "tracked");
    git::run(dir.path(), &["add", "."]).unwrap();
    git::run(dir.path(), &["commit", "-qm", "initial"]).unwrap();
    dir
}

fn write(root: &Path, path: &str, value: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}

fn patterns(values: &[&str]) -> Vec<String> { values.iter().map(|s| s.to_string()).collect() }

#[test]
fn globs_are_relative_and_distinguish_direct_and_recursive_matches() {
    let glob = matcher(".env*").unwrap();
    assert!(glob.is_match(".env"));
    assert!(glob.is_match(".env.local"));
    assert!(!glob.is_match("config/.env"));
    let glob = matcher("config/local/**").unwrap();
    assert!(glob.is_match("config/local/app.json"));
    assert!(glob.is_match("config/local/nested/app.json"));
    assert!(!glob.is_match("config/public/app.json"));
    for invalid in ["/etc/*", "../secret", "config/../secret", ".git/**", "C:/secret", "config\\secret", "[", ""] {
        assert!(matcher(invalid).is_err(), "{invalid}");
    }
    assert!(validate_patterns(&vec![".env".into(); MAX_PATTERNS + 1]).is_err());
}

#[test]
fn preview_only_lists_ignored_files_and_excludes_managed_workspaces() {
    let _home = crate::store::temp_home();
    let repo = repo();
    write(repo.path(), ".env", "private");
    write(repo.path(), ".env.tracked", "tracked secret example");
    git::run(repo.path(), &["add", "-f", ".env.tracked"]).unwrap();
    write(repo.path(), "untracked.txt", "not ignored");
    write(repo.path(), "config/local/nested/app.json", "local");
    write(repo.path(), "config/local/spaces and\nnewlines", "local");
    git::ensure_worktree_dir_ignored(repo.path());
    write(&git::worktree_root(repo.path()), "older/.env", "old");
    let result = preview(repo.path(), Some(&patterns(&["**"]))).unwrap();
    assert_eq!(result.patterns[0].matches, patterns(&[".env", "config/local/nested/app.json", "config/local/spaces and\nnewlines"]));
    assert!(!result.from_include_file);
    let result = preview(repo.path(), Some(&patterns(&["[", ".env*"]))).unwrap();
    assert!(result.patterns[0].error.is_some());
    assert_eq!(result.patterns[1].matches, patterns(&[".env"]));
}

#[test]
fn include_file_replaces_stored_and_draft_patterns_even_when_empty() {
    let _home = crate::store::temp_home();
    let repo = repo();
    let project = projects::add(repo.path().to_str().unwrap()).unwrap();
    projects::update(&project.path, projects::ProjectPatch { repository_settings: Some(projects::RepositorySettings { files_to_copy: patterns(&[".env*"]) }), ..Default::default() }).unwrap();
    write(repo.path(), ".env", "private");
    write(repo.path(), "config/local/app.json", "local");
    write(repo.path(), ".worktreeinclude", "# team choices\n\nconfig/local/**\r\n");
    let result = preview(repo.path(), Some(&patterns(&[".env*"]))).unwrap();
    assert!(result.from_include_file);
    assert_eq!(result.patterns.len(), 1);
    assert_eq!(result.patterns[0].matches, patterns(&["config/local/app.json"]));
    let created = git::create_worktree(repo.path(), "included", Some("main")).unwrap();
    assert!(Path::new(&created.path).join("config/local/app.json").is_file());
    assert!(!Path::new(&created.path).join(".env").exists());
    assert!(projects::update(&project.path, projects::ProjectPatch { repository_settings: Some(Default::default()), ..Default::default() }).is_err());
    write(repo.path(), ".worktreeinclude", "# intentionally empty\n");
    assert!(preview(repo.path(), None).unwrap().patterns.is_empty());
    fs::remove_file(repo.path().join(".worktreeinclude")).unwrap();
    assert_eq!(preview(repo.path(), None).unwrap().patterns[0].matches, patterns(&[".env"]));
    assert_eq!(projects::list().unwrap().0[0].repository_settings.files_to_copy, patterns(&[".env*"]));
    // The same serialized Project is returned by `terminalx projects list`.
    assert_eq!(serde_json::to_value(&projects::list().unwrap().0[0]).unwrap()["repositorySettings"]["filesToCopy"], serde_json::json!([".env*"]));
}

#[test]
fn create_and_checkout_copy_saved_patterns_before_returning() {
    let _home = crate::store::temp_home();
    let repo = repo();
    let project = projects::add(repo.path().to_str().unwrap()).unwrap();
    projects::update(&project.path, projects::ProjectPatch { repository_settings: Some(projects::RepositorySettings { files_to_copy: patterns(&[".env*", "config/local/**"]) }), ..Default::default() }).unwrap();
    write(repo.path(), ".env", "SECRET=value\n");
    write(repo.path(), "config/local/app.json", "local");
    let worktree = git::create_worktree(repo.path(), "copy-test", Some("main")).unwrap();
    assert_eq!(fs::read_to_string(Path::new(&worktree.path).join(".env")).unwrap(), "SECRET=value\n");
    assert_eq!(fs::read_to_string(Path::new(&worktree.path).join("config/local/app.json")).unwrap(), "local");
    let report = worktree.worktree_base.unwrap().file_copy.unwrap();
    assert_eq!(report.copied, patterns(&[".env", "config/local/app.json"]));
    assert!(report.skipped.is_empty());
    git::run(repo.path(), &["branch", "existing"]).unwrap();
    let checkout = git::checkout_worktree(repo.path(), "existing-checkout", "existing").unwrap();
    assert_eq!(fs::read_to_string(Path::new(&checkout.path).join(".env")).unwrap(), "SECRET=value\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(Path::new(&checkout.path).join(".env")).unwrap().permissions().mode() & 0o077, 0);
    }
}

#[test]
fn include_file_controls_copy_and_tracked_destination_files_are_never_overwritten() {
    let _home = crate::store::temp_home();
    let repo = repo();
    write(repo.path(), ".env", "tracked on other branch");
    git::run(repo.path(), &["checkout", "-qb", "tracked-env"]).unwrap();
    git::run(repo.path(), &["add", "-f", ".env"]).unwrap();
    git::run(repo.path(), &["commit", "-qm", "track env"]).unwrap();
    git::run(repo.path(), &["checkout", "-q", "main"]).unwrap();
    write(repo.path(), ".env", "local secret");
    write(repo.path(), ".worktreeinclude", ".env*\n**/.env\n");
    let worktree = git::create_worktree(repo.path(), "protected", Some("tracked-env")).unwrap();
    let dest = Path::new(&worktree.path);
    assert_eq!(fs::read_to_string(dest.join(".env")).unwrap(), "tracked on other branch");
    let report = worktree.worktree_base.unwrap().file_copy.unwrap();
    assert_eq!(report.skipped.len(), 1);
    assert!(report.skipped[0].reason.contains("Tracked"));
    // Even a tracked path absent from disk must remain protected.
    fs::remove_file(dest.join(".env")).unwrap();
    assert_eq!(copy_files(repo.path(), dest).unwrap().skipped.len(), 1);
    assert!(!dest.join(".env").exists());
}

#[test]
fn existing_files_are_kept_and_overlapping_patterns_copy_once() {
    let _home = crate::store::temp_home();
    let repo = repo();
    write(repo.path(), ".env", "original");
    write(repo.path(), ".worktreeinclude", ".env*\n.env\n");
    let worktree = git::create_worktree(repo.path(), "overlap", Some("main")).unwrap();
    assert_eq!(worktree.worktree_base.unwrap().file_copy.unwrap().copied, patterns(&[".env"]));
    let dest = Path::new(&worktree.path);
    write(dest, ".env", "workspace value");
    assert_eq!(copy_files(repo.path(), dest).unwrap().skipped.len(), 1);
    assert_eq!(fs::read_to_string(dest.join(".env")).unwrap(), "workspace value");
}

#[cfg(unix)]
#[test]
fn symbolic_links_and_special_files_cannot_escape_or_hang_copying() {
    use std::os::unix::fs::symlink;
    let _home = crate::store::temp_home();
    let repo = repo();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "secret", "outside secret");
    symlink(outside.path().join("secret"), repo.path().join(".env.link")).unwrap();
    write(repo.path(), "config/local/app", "local");
    write(repo.path(), ".worktreeinclude", ".env*\nconfig/local/**\n");
    let dest = tempfile::tempdir().unwrap();
    symlink(outside.path(), dest.path().join("config")).unwrap();
    assert!(copy_one(repo.path(), dest.path(), Path::new(".env.link")).is_err());
    assert!(copy_one(repo.path(), dest.path(), Path::new("config/local/app")).is_err());
    assert!(!outside.path().join("local").exists());
    symlink(outside.path(), repo.path().join("cache")).unwrap();
    assert!(copy_one(repo.path(), dest.path(), Path::new("cache/secret")).is_err());
    fs::remove_file(repo.path().join(".worktreeinclude")).unwrap();
    symlink(outside.path().join("secret"), repo.path().join(".worktreeinclude")).unwrap();
    let preview = preview(repo.path(), None).unwrap();
    assert!(preview.from_include_file);
    assert!(preview.error.unwrap().contains(".worktreeinclude"));
    assert!(!preview.workspaces_path.is_empty());
    let created = git::create_worktree(repo.path(), "unsafe-include", Some("main")).unwrap();
    assert!(created.worktree_base.unwrap().file_copy.unwrap().error.is_some());
    assert!(!Path::new(&created.path).join(".env.link").exists());
    let fifo = std::ffi::CString::new(repo.path().join(".env.fifo").to_str().unwrap()).unwrap();
    // SAFETY: the path is a valid C string in this test's private temp directory.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(copy_one(repo.path(), dest.path(), Path::new(".env.fifo")).is_err());
}

#[test]
fn old_project_records_default_to_no_copy_patterns() {
    let project: projects::Project = serde_json::from_value(serde_json::json!({"path":"/repo", "name":"repo"})).unwrap();
    assert_eq!(project.repository_settings, projects::RepositorySettings::default());
}

#[cfg(unix)]
#[test]
fn failed_writes_leave_no_partial_file_and_successful_copies_preserve_owner_execute() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let error = safe_open::write_atomic(root.path(), Path::new(".env"), |file| {
        file.write_all(b"PARTIAL=")?;
        anyhow::bail!("injected copy failure");
    }).unwrap_err();
    assert!(error.to_string().contains("injected copy failure"));
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    let source = tempfile::tempdir().unwrap();
    write(source.path(), "setup", "#!/bin/sh\n");
    fs::set_permissions(source.path().join("setup"), fs::Permissions::from_mode(0o755)).unwrap();
    copy_one(source.path(), root.path(), Path::new("setup")).unwrap();
    assert_eq!(fs::metadata(root.path().join("setup")).unwrap().permissions().mode() & 0o777, 0o700);
}
