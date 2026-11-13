use super::*;

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    dir
}

fn init_repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    git::run(path, &["init", "-q", "-b", "main"]).unwrap();
    git::run(path, &["config", "user.name", "Test"]).unwrap();
    git::run(path, &["config", "user.email", "test@example.com"]).unwrap();
    // The different-base regression must depend only on this fixture's rules,
    // even when the developer globally ignores .env files.
    let excludes = path.join(".git/test-global-ignore");
    fs::write(&excludes, "").unwrap();
    git::run(path, &["config", "core.excludesFile", excludes.to_str().unwrap()]).unwrap();
    write(path, ".gitignore", ".env*\nconfig/local/\ncache/\n");
    write(path, "tracked.txt", "tracked");
    git::run(path, &["add", "."]).unwrap();
    git::run(path, &["commit", "-qm", "initial"]).unwrap();
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
    for invalid in ["/etc/*", "../secret", "config/../secret", ".git/**", ".GIT/**", "!secret", "C:/secret", "config\\secret", "[", ""] {
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
    let result = preview(repo.path(), Some(&patterns(&["**"])), None).unwrap();
    assert_eq!(result.patterns[0].matches, patterns(&[".env", "config/local/nested/app.json", "config/local/spaces and\nnewlines"]));
    assert!(!result.from_include_file);
    let result = preview(repo.path(), Some(&patterns(&["[", ".env*"])), None).unwrap();
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
    let result = preview(repo.path(), Some(&patterns(&[".env*"])), None).unwrap();
    assert!(result.from_include_file);
    assert_eq!(result.patterns.len(), 1);
    assert_eq!(result.patterns[0].matches, patterns(&["config/local/app.json"]));
    let created = git::create_worktree(repo.path(), "included", Some("main")).unwrap();
    assert!(Path::new(&created.path).join("config/local/app.json").is_file());
    assert!(!Path::new(&created.path).join(".env").exists());
    assert!(projects::update(&project.path, projects::ProjectPatch { repository_settings: Some(Default::default()), ..Default::default() }).is_err());
    write(repo.path(), ".worktreeinclude", "# intentionally empty\n");
    assert!(preview(repo.path(), None, None).unwrap().patterns.is_empty());
    fs::remove_file(repo.path().join(".worktreeinclude")).unwrap();
    assert_eq!(preview(repo.path(), None, None).unwrap().patterns[0].matches, patterns(&[".env"]));
    assert_eq!(projects::list().unwrap().0[0].repository_settings.files_to_copy, patterns(&[".env*"]));
    // The same serialized Project is returned by `terminalx projects list`.
    assert_eq!(serde_json::to_value(&projects::list().unwrap().0[0]).unwrap()["repositorySettings"]["filesToCopy"], serde_json::json!([".env*"]));
}

#[test]
fn repository_copy_settings_and_scripts_survive_independent_updates() {
    let _home = crate::store::temp_home();
    let repo = repo();
    let project = projects::add(repo.path().to_str().unwrap()).unwrap();
    let scripts = projects::RepositoryScripts { setup: "echo setup".into(), archive: "echo archive".into(), archive_timeout_minutes: None };
    projects::update(&project.path, projects::ProjectPatch { scripts: Some(scripts.clone()), ..Default::default() }).unwrap();
    projects::update(&project.path, projects::ProjectPatch {
        repository_settings: Some(projects::RepositorySettings { files_to_copy: patterns(&[".env*"]) }),
        ..Default::default()
    }).unwrap();
    assert_eq!(projects::scripts(repo.path()).unwrap(), scripts);
    // Repository-file precedence only locks the copy list, not scripts or other project choices.
    write(repo.path(), ".worktreeinclude", ".env*\n");
    projects::update(&project.path, projects::ProjectPatch { scripts: Some(Default::default()), ..Default::default() }).unwrap();
    assert_eq!(projects::repository_settings(repo.path()).unwrap().files_to_copy, patterns(&[".env*"]));
    assert_eq!(projects::scripts(repo.path()).unwrap(), projects::RepositoryScripts::default());
    write(repo.path(), ".env", "private");
    let created = git::create_worktree(repo.path(), "after-script-update", Some("main")).unwrap();
    assert_eq!(fs::read_to_string(Path::new(&created.path).join(".env")).unwrap(), "private");
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
    assert_eq!(report.copied_count, 2);
    assert_eq!(report.copied_bytes, 18);
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
    assert_eq!(worktree.worktree_base.unwrap().file_copy.unwrap().copied_count, 1);
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
    assert!(copy_path(repo.path(), dest.path(), Path::new(".env.link"), MAX_COPY_BYTES).is_err());
    assert!(copy_path(repo.path(), dest.path(), Path::new("config/local/app"), MAX_COPY_BYTES).is_err());
    assert!(!outside.path().join("local").exists());
    symlink(outside.path(), repo.path().join("cache")).unwrap();
    assert!(copy_path(repo.path(), dest.path(), Path::new("cache/secret"), MAX_COPY_BYTES).is_err());
    fs::remove_file(repo.path().join(".worktreeinclude")).unwrap();
    symlink(outside.path().join("secret"), repo.path().join(".worktreeinclude")).unwrap();
    let preview = preview(repo.path(), None, None).unwrap();
    assert!(preview.from_include_file);
    assert!(preview.error.unwrap().contains(".worktreeinclude"));
    assert!(!preview.workspaces_path.is_empty());
    let created = git::create_worktree(repo.path(), "unsafe-include", Some("main")).unwrap();
    assert!(created.worktree_base.unwrap().file_copy.unwrap().error.is_some());
    assert!(!Path::new(&created.path).join(".env.link").exists());
    let fifo = std::ffi::CString::new(repo.path().join(".env.fifo").to_str().unwrap()).unwrap();
    // SAFETY: the path is a valid C string in this test's private temp directory.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(copy_path(repo.path(), dest.path(), Path::new(".env.fifo"), MAX_COPY_BYTES).is_err());
}

#[test]
fn old_project_records_default_to_no_copy_patterns() {
    let project: projects::Project = serde_json::from_value(serde_json::json!({"path":"/repo", "name":"repo"})).unwrap();
    assert_eq!(project.repository_settings, projects::RepositorySettings::default());
    let legacy: CopyReport = serde_json::from_value(serde_json::json!({"copied":[".env"], "skipped":[], "error":null})).unwrap();
    assert_eq!(legacy, CopyReport::default());
}

#[test]
fn different_base_ignore_rules_cannot_expose_secrets_in_create_or_checkout() {
    let _home = crate::store::temp_home();
    let repo = repo();
    git::run(repo.path(), &["checkout", "-qb", "no-ignore"]).unwrap();
    git::run(repo.path(), &["rm", ".gitignore"]).unwrap();
    git::run(repo.path(), &["commit", "-qm", "remove ignores"]).unwrap();
    git::run(repo.path(), &["checkout", "-q", "main"]).unwrap();
    write(repo.path(), ".env", "secret");
    write(repo.path(), ".worktreeinclude", ".env\n");
    let created = git::create_worktree(repo.path(), "different-base", Some("no-ignore")).unwrap();
    let checked_out = git::checkout_worktree(repo.path(), "different-checkout", "no-ignore").unwrap();
    for worktree in [created, checked_out] {
        let destination = Path::new(&worktree.path);
        assert!(!destination.join(".env").exists());
        let report = worktree.worktree_base.unwrap().file_copy.unwrap();
        assert_eq!(report.copied_count, 0);
        assert_eq!(report.skipped_count, 1);
        assert!(report.skipped[0].reason.contains("not ignored"));
        git::run(destination, &["add", "-A"]).unwrap();
        assert!(git::run(destination, &["diff", "--cached", "--name-only"]).unwrap().is_empty());
    }
}

#[test]
fn copied_ignore_rules_cannot_make_a_secret_visible_to_git() {
    let _home = crate::store::temp_home();
    let repo = repo();
    write(repo.path(), ".gitignore", "secrets/\n");
    git::run(repo.path(), &["commit", "-qam", "ignore source directory"]).unwrap();
    git::run(repo.path(), &["checkout", "-qb", "destination-rules"]).unwrap();
    write(repo.path(), ".gitignore", "secrets/*\n");
    git::run(repo.path(), &["commit", "-qam", "ignore destination files"]).unwrap();
    git::run(repo.path(), &["checkout", "-q", "main"]).unwrap();
    write(repo.path(), "secrets/.env", "local secret");
    write(repo.path(), "secrets/.gitignore", "!.env\n");
    write(repo.path(), ".worktreeinclude", "secrets/**\n");
    let created = git::create_worktree(repo.path(), "keep-ignore-rules", Some("destination-rules")).unwrap();
    let checked_out = git::checkout_worktree(repo.path(), "keep-ignore-checkout", "destination-rules").unwrap();
    for worktree in [created, checked_out] {
        let destination = Path::new(&worktree.path);
        let report = worktree.worktree_base.unwrap().file_copy.unwrap();
        assert_eq!(report.copied_count, 1);
        assert_eq!(report.skipped_count, 1);
        assert_eq!(report.skipped[0].path, "secrets/.gitignore");
        assert!(report.skipped[0].reason.contains("ignore rules"));
        assert_eq!(fs::read_to_string(destination.join("secrets/.env")).unwrap(), "local secret");
        assert!(!destination.join("secrets/.gitignore").exists());
        git::run(destination, &["check-ignore", "secrets/.env"]).unwrap();
        git::run(destination, &["add", "-A"]).unwrap();
        assert!(git::run(destination, &["diff", "--cached", "--name-only"]).unwrap().is_empty());
        // Case-insensitive filesystems must not accept an alternate spelling.
        assert!(copy_path(repo.path(), destination, Path::new("secrets/.GITIGNORE"), MAX_COPY_BYTES)
            .unwrap_err().to_string().contains("ignore rules"));
    }
}

#[test]
fn staging_cannot_expose_copies_in_the_surrounding_repository() {
    let _home = crate::store::temp_home();
    let repo = repo();
    // A higher-priority repository rule can override info/exclude's managed
    // workspace rule. Refuse to leave temporary secrets visible in that parent.
    write(repo.path(), ".gitignore", ".env*\n!/.raccoon/\n");
    git::run(repo.path(), &["commit", "-qam", "make managed parent visible"]).unwrap();
    write(repo.path(), ".env", "local secret");
    write(repo.path(), ".worktreeinclude", ".env\n");
    let created = git::create_worktree(repo.path(), "unsafe-staging", Some("main")).unwrap();
    let report = created.worktree_base.unwrap().file_copy.unwrap();
    assert!(report.error.unwrap().contains("Workspace parent must be ignored"));
    assert!(!Path::new(&created.path).join(".env").exists());
    assert!(!fs::read_dir(git::worktree_root(repo.path())).unwrap()
        .any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".terminalx-copy-")));
    let broken = tempfile::tempdir().unwrap();
    let destination = broken.path().join("workspace");
    fs::create_dir(&destination).unwrap();
    write(broken.path(), ".git", "gitdir: missing\n");
    assert!(validate_staging_directory(&CopyDestination::open(&destination).unwrap().staging).is_err());
}

#[cfg(unix)]
#[test]
fn configured_workspace_parent_aliases_still_copy_files() {
    let _home = crate::store::temp_home();
    let repo = repo();
    let workspaces = tempfile::tempdir().unwrap();
    let root = git::worktree_root(repo.path());
    fs::create_dir_all(root.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(workspaces.path(), &root).unwrap();
    write(repo.path(), ".env", "local secret");
    write(repo.path(), ".worktreeinclude", ".env\n");
    let created = git::create_worktree(repo.path(), "aliased-parent", Some("main")).unwrap();
    assert_eq!(created.worktree_base.unwrap().file_copy.unwrap().copied_count, 1);
    assert_eq!(fs::read_to_string(Path::new(&created.path).join(".env")).unwrap(), "local secret");
}

#[test]
fn scan_limits_discard_partial_names_without_corrupting_utf8() {
    let repo = repo();
    write(repo.path(), ".env.a", "a");
    write(repo.path(), ".env.é", "b");
    let args = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"];
    let (names, limited) = git::file_names_bounded(safe_open::Directory::open_resolved(&fs::canonicalize(repo.path()).unwrap()).unwrap().command().unwrap(), &args, 1, 100).unwrap();
    assert_eq!(names, patterns(&[".env.a"]));
    assert!(limited);
    // Seven bytes for the first name + NUL, then stop inside the second é.
    let (names, limited) = git::file_names_bounded(safe_open::Directory::open_resolved(&fs::canonicalize(repo.path()).unwrap()).unwrap().command().unwrap(), &args, 10, 13).unwrap();
    assert_eq!(names, patterns(&[".env.a"]));
    assert!(limited);
    let (names, limited) = git::file_names_bounded(safe_open::Directory::open_resolved(&fs::canonicalize(repo.path()).unwrap()).unwrap().command().unwrap(), &args, 10, 100).unwrap();
    assert_eq!(names, patterns(&[".env.a", ".env.é"]));
    assert!(!limited);
}

#[test]
fn previews_and_copy_reports_are_bounded_and_copy_limits_preserve_checkout() {
    let _home = crate::store::temp_home();
    let repo = repo();
    for index in 0..205 { write(repo.path(), &format!(".env.{index:03}"), "secret"); }
    let result = preview(repo.path(), Some(&patterns(&[".env*"])), None).unwrap();
    assert_eq!(result.patterns[0].matches.len(), MAX_PREVIEW_MATCHES);
    assert_eq!(result.patterns[0].omitted, 105);
    // Create an empty checkout, then enable copying for bounded test runs.
    let worktree = git::create_worktree(repo.path(), "limited", Some("main")).unwrap();
    let dest = Path::new(&worktree.path);
    write(repo.path(), ".worktreeinclude", ".env*\n");
    let report = copy_files_with_limits(repo.path(), dest, 2, 6).unwrap();
    assert_eq!(report.copied_count, 1);
    assert_eq!(report.copied_bytes, 6);
    assert_eq!(report.skipped_count, 204);
    assert_eq!(report.skipped.len(), MAX_REPORT_DETAILS);
    assert!(report.skipped[0].reason.contains("byte limit"));
    assert!(report.skipped[1].reason.contains("matching files"));
    assert!(dest.join(".env.000").is_file());
    assert!(!dest.join(".env.001").exists());
    assert!(!dest.join(".env.002").exists());
    assert_eq!(fs::read_to_string(dest.join("tracked.txt")).unwrap(), "tracked");
}

#[test]
fn preview_snapshots_reuse_scans_but_creation_always_rescans() {
    let _home = crate::store::temp_home();
    let repo = repo();
    write(repo.path(), ".env.first", "first");
    let draft = patterns(&[".env*"]);
    assert_eq!(preview(repo.path(), Some(&draft), Some("page")).unwrap().patterns[0].matches.len(), 1);
    write(repo.path(), ".env.second", "second");
    assert_eq!(preview(repo.path(), Some(&draft), Some("page")).unwrap().patterns[0].matches.len(), 1);
    assert_eq!(preview(repo.path(), Some(&draft), Some("refreshed")).unwrap().patterns[0].matches.len(), 2);
    write(repo.path(), ".worktreeinclude", ".env*\n");
    write(repo.path(), ".env.third", "third");
    let worktree = git::create_worktree(repo.path(), "fresh-scan", Some("main")).unwrap();
    assert_eq!(worktree.worktree_base.unwrap().file_copy.unwrap().copied_count, 3);
    assert!(Path::new(&worktree.path).join(".env.third").is_file());
}

#[test]
fn snapshot_cache_is_bounded_and_separates_repositories() {
    let mut cache = PreviewCache::default();
    let empty = || Ok(IgnoredFiles { files: Vec::new(), limited: false });
    cache.get(Path::new("a"), "token", empty).unwrap();
    cache.get(Path::new("a"), "token", || panic!("must reuse scan")).unwrap();
    cache.get(Path::new("b"), "token", empty).unwrap();
    for token in ["two", "three", "four"] { cache.get(Path::new("a"), token, empty).unwrap(); }
    assert_eq!(cache.entries.len(), 4);
    assert!(!cache.entries.iter().any(|entry| entry.project == Path::new("a") && entry.token == "token"));
}

#[test]
fn cleanup_failure_does_not_misreport_a_published_file_as_skipped() {
    let denied = || std::io::Error::from(std::io::ErrorKind::PermissionDenied);
    assert!(finish_publication(Ok(()), Err(denied())).unwrap().unwrap().contains("Copied, but"));
    let error = finish_publication(Err(anyhow::anyhow!("publication failed")), Err(denied())).unwrap_err();
    let message = format!("{error:#}");
    assert!(message.contains("publication failed"));
    assert!(message.contains("temporary file"));
}

#[cfg(unix)]
#[test]
fn growing_source_cannot_publish_a_file_beyond_the_byte_budget() {
    let root = tempfile::tempdir().unwrap();
    let mut source = std::io::Cursor::new(b"larger than the metadata indicated");
    let error = safe_open::write_atomic(&CopyDestination::open(root.path()).unwrap(), Path::new(".env"), |target| {
        copy_bounded(&mut source, target, 5).map(|_| ())
    }).unwrap_err();
    assert!(error.to_string().contains("byte limit"));
    assert_eq!(source.position(), 6);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn failed_writes_leave_no_partial_file_and_successful_copies_preserve_owner_execute() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let staging = tempfile::tempdir().unwrap();
    let root = staging.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let error = safe_open::write_atomic(&CopyDestination::open(&root).unwrap(), Path::new(".env"), |file| {
        // Even while writing, no unignored temporary secret exists in the checkout.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 2);
        file.write_all(b"PARTIAL=")?;
        anyhow::bail!("injected copy failure");
    }).unwrap_err();
    assert!(error.to_string().contains("injected copy failure"));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 1);
    let source = tempfile::tempdir().unwrap();
    write(source.path(), "setup", "#!/bin/sh\n");
    fs::set_permissions(source.path().join("setup"), fs::Permissions::from_mode(0o755)).unwrap();
    copy_path(source.path(), &root, Path::new("setup"), MAX_COPY_BYTES).unwrap();
    assert_eq!(fs::metadata(root.join("setup")).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn copy_batch_keeps_validated_destination_and_staging_after_ancestor_swap() {
    let _home = crate::store::temp_home();
    let repo = repo();
    let created = git::create_worktree(repo.path(), "bound", Some("main")).unwrap();
    write(repo.path(), ".env", "validated secret");
    write(repo.path(), ".worktreeinclude", ".env\n");
    let destination = Path::new(&created.path);
    let plan = CopyPlan::prepare(repo.path(), destination, MAX_COPY_FILES, MAX_COPY_BYTES).unwrap();
    let outside = self::repo();
    write(outside.path(), ".gitignore", "");
    let replacement = outside.path().join("worktrees/bound");
    fs::create_dir_all(&replacement).unwrap();
    let ancestor = repo.path().join(".raccoon");
    let held = repo.path().join(".raccoon-held");
    fs::rename(&ancestor, &held).unwrap();
    std::os::unix::fs::symlink(outside.path(), &ancestor).unwrap();
    let report = plan.execute().unwrap();
    assert!(!replacement.join(".env").exists(), "secret published in unvalidated checkout");
    assert_eq!(fs::read_dir(outside.path().join("worktrees")).unwrap().count(), 1, "temporary secret escaped staging");
    assert_eq!(report.copied_count, 1);
    assert_eq!(fs::read_to_string(held.join("worktrees/bound/.env")).unwrap(), "validated secret");
}

#[cfg(unix)]
#[test]
fn copy_batch_keeps_validated_source_after_ancestor_swap() {
    let _home = crate::store::temp_home();
    let container = tempfile::tempdir().unwrap();
    let source_parent = container.path().join("source");
    let source = source_parent.join("repo");
    init_repo(&source);
    let destination = repo();
    write(&source, ".env", "validated secret");
    write(&source, ".worktreeinclude", ".env\n");
    let plan = CopyPlan::prepare(&source, destination.path(), MAX_COPY_FILES, MAX_COPY_BYTES).unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "repo/.env", "unvalidated secret");
    fs::rename(&source_parent, container.path().join("held")).unwrap();
    std::os::unix::fs::symlink(outside.path(), &source_parent).unwrap();
    let report = plan.execute().unwrap();
    assert_eq!(report.copied_count, 1);
    assert_eq!(fs::read_to_string(destination.path().join(".env")).unwrap(), "validated secret");
}

fn copy_path(project: &Path, destination: &Path, relative: &Path, remaining_bytes: u64) -> Result<(u64, Option<String>)> {
    copy_one(&safe_open::Directory::open_resolved(&fs::canonicalize(project)?)?, &CopyDestination::open(destination)?, relative, remaining_bytes)
}

#[cfg(unix)]
#[test]
fn staging_and_cleanup_keep_the_bound_parent_during_an_ancestor_swap() {
    use std::io::Write;
    let container = tempfile::tempdir().unwrap();
    let parent = container.path().join("parent");
    let root = parent.join("staging/workspace");
    fs::create_dir_all(&root).unwrap();
    let destination = CopyDestination::open(&root).unwrap();
    let outside = repo();
    write(outside.path(), ".gitignore", "");
    fs::create_dir_all(outside.path().join("staging/workspace")).unwrap();
    let held = container.path().join("held");
    fs::rename(&parent, &held).unwrap();
    std::os::unix::fs::symlink(outside.path(), &parent).unwrap();
    safe_open::write_atomic(&destination, Path::new(".env"), |file| {
        file.write_all(b"private")?;
        // Check while the temporary file contains the secret, before cleanup
        // could hide a transient write into the replacement checkout.
        assert_eq!(fs::read_dir(outside.path().join("staging"))?.count(), 1);
        assert_eq!(fs::read_dir(held.join("staging"))?.count(), 2);
        Ok(())
    }).unwrap();
    assert!(!outside.path().join("staging/workspace/.env").exists());
    assert_eq!(fs::read_dir(held.join("staging")).unwrap().count(), 1);
    assert_eq!(fs::read_to_string(held.join("staging/workspace/.env")).unwrap(), "private");
}

#[cfg(unix)]
#[test]
fn git_eligibility_uses_the_bound_source_after_an_ancestor_swap() {
    let _home = crate::store::temp_home();
    let container = tempfile::tempdir().unwrap();
    let parent = container.path().join("source");
    let source = parent.join("repo");
    init_repo(&source);
    write(&source, ".env.original", "private");
    let resolved = fs::canonicalize(&source).unwrap();
    let root = safe_open::Directory::open_resolved(&resolved).unwrap();
    let outside = tempfile::tempdir().unwrap();
    init_repo(&outside.path().join("repo"));
    write(outside.path(), "repo/.env.replacement", "different");
    fs::rename(&parent, container.path().join("held")).unwrap();
    std::os::unix::fs::symlink(outside.path(), &parent).unwrap();
    validate_repository_root(&root).unwrap();
    assert_eq!(ignored_files(&resolved, &root).unwrap().files, patterns(&[".env.original"]));
    assert_eq!(git::ignored_untracked_paths(root.command().unwrap(), &patterns(&[".env.original", "tracked.txt"])).unwrap(),
        BTreeSet::from([String::from(".env.original")]));
    // Resolving aliases is allowed before binding. Once resolved, binding must
    // refuse a newly substituted symlink in any component, not just the leaf.
    assert!(safe_open::Directory::open_resolved(&resolved).is_err());
}
