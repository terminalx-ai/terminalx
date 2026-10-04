use super::*;

struct Fixture {
    _dir: tempfile::TempDir,
    home: PathBuf,
    mirror: Mirror,
    /// The workspace's files, as the runtime would serve them.
    remote: BTreeMap<String, (Vec<u8>, bool, u32)>,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let mirror = Mirror::at(&home, "org-1", "workspace-1").unwrap();
        mirror.enable().unwrap();
        Self { _dir: dir, home, mirror, remote: BTreeMap::new() }
    }

    fn files(&self) -> PathBuf {
        self.home.join("cloud-mirrors/org-1/workspace-1/files")
    }

    /// The workspace writes a file (a new version each time).
    fn remote_write(&mut self, path: &str, content: &str) {
        let generation = self.remote.get(path).map_or(1, |(_, _, generation)| generation + 1);
        self.remote.insert(path.into(), (content.as_bytes().to_vec(), false, generation));
    }

    fn manifest(&self) -> Manifest {
        let entries: Vec<Entry> = self
            .remote
            .iter()
            .map(|(path, (bytes, executable, generation))| Entry { path: path.clone(), size: bytes.len() as u64, version: format!("v{generation}"), executable: *executable })
            .collect();
        let id = etag(format!("{entries:?}").as_bytes());
        Manifest { manifest_id: id, repositories: vec![Repository { repo: ".".into(), branch: Some("main".into()), head: Some("a".repeat(40)) }], entries, truncated: false }
    }

    /// One whole sync, as the frontend runs it: plan, read and stage, publish.
    fn sync(&self) -> Result<Published> {
        let manifest = self.manifest();
        let plan = self.mirror.plan(&manifest)?;
        let mut etags = BTreeMap::new();
        for path in &plan.fetch {
            let bytes = &self.remote[path].0;
            self.mirror.stage(path, bytes, bytes.len() as u64, &etag(bytes))?;
            etags.insert(path.clone(), etag(bytes));
        }
        self.mirror.publish(&manifest, &etags)
    }

    fn local(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.files().join(path)).ok()
    }

    fn write_local(&self, path: &str, content: &str) {
        let file = self.files().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
}

fn reasons(diverged: &[Divergence]) -> Vec<(&str, &str)> {
    diverged.iter().map(|item| (item.path.as_str(), item.reason)).collect()
}

#[test]
fn a_first_sync_copies_the_file_set_and_records_its_revision() {
    let mut f = Fixture::new();
    f.remote_write("README.md", "hello\n");
    f.remote_write("src/main.rs", "fn main() {}\n");
    f.remote.insert("bin/run.sh".into(), (b"#!/bin/sh\n".to_vec(), true, 1));

    // Turning the mirror on copies nothing by itself.
    assert_eq!(f.mirror.status().unwrap().files, 0);
    assert_eq!(std::fs::read_dir(f.files()).unwrap().count(), 0);

    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.fetch, ["README.md", "bin/run.sh", "src/main.rs"]);
    assert_eq!((plan.remove, plan.unchanged, plan.diverged_total, plan.up_to_date), (0, 0, 0, false));

    let published = f.sync().unwrap();
    assert_eq!((published.written, published.removed, published.diverged_total), (3, 0, 0));
    assert_eq!(f.local("README.md").as_deref(), Some("hello\n"));
    assert_eq!(f.local("src/main.rs").as_deref(), Some("fn main() {}\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &str| std::fs::metadata(f.files().join(path)).unwrap().permissions().mode() & 0o777;
        // The workspace says run.sh is executable. Here nothing ever is.
        assert_eq!(mode("bin/run.sh"), 0o644);
        assert_eq!(mode("README.md"), 0o644);
    }
    let revision = published.status.revision.unwrap();
    assert_eq!(revision.manifest_id, f.manifest().manifest_id);
    assert_eq!((revision.files, revision.bytes), (3, 6 + 13 + 10));
    assert_eq!(revision.repositories[0].branch.as_deref(), Some("main"));
    assert!(published.status.root.ends_with("cloud-mirrors/org-1/workspace-1/files"));

    // Nothing changed in the workspace: nothing to read, nothing written.
    let again = f.mirror.plan(&f.manifest()).unwrap();
    assert!(again.up_to_date);
    assert_eq!((again.fetch.len(), again.unchanged), (0, 3));
    // No staging or journal is left behind.
    assert!(!f.home.join("cloud-mirrors/org-1/workspace-1/staging").exists());
    assert!(!f.home.join("cloud-mirrors/org-1/workspace-1/journal.json").exists());
}

#[test]
fn remote_edits_creates_and_deletes_are_applied_and_local_only_files_are_left_alone() {
    let mut f = Fixture::new();
    f.remote_write("a.txt", "one\n");
    f.remote_write("dir/deep/b.txt", "two\n");
    f.remote_write("dir/c.txt", "three\n");
    f.sync().unwrap();
    // A local tool's own output, at a path the workspace does not use.
    f.write_local("dir/deep/notes.local", "mine\n");
    f.write_local("build/out.o", "mine\n");

    f.remote_write("a.txt", "one, edited\n");
    f.remote.remove("dir/c.txt");
    f.remote.remove("dir/deep/b.txt");
    f.remote_write("new/d.txt", "four\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.fetch, ["a.txt", "new/d.txt"]);
    assert_eq!((plan.remove, plan.diverged_total), (2, 0));
    let published = f.sync().unwrap();
    assert_eq!((published.written, published.removed), (2, 2));
    assert_eq!(f.local("a.txt").as_deref(), Some("one, edited\n"));
    assert_eq!(f.local("new/d.txt").as_deref(), Some("four\n"));
    assert_eq!(f.local("dir/c.txt"), None);
    assert_eq!(f.local("dir/deep/b.txt"), None);
    // Never uploaded, never deleted, not a conflict; its folder is kept for it.
    assert_eq!(f.local("dir/deep/notes.local").as_deref(), Some("mine\n"));
    assert_eq!(f.local("build/out.o").as_deref(), Some("mine\n"));

    // A folder the removals emptied is pruned.
    f.remote.remove("new/d.txt");
    f.sync().unwrap();
    assert!(!f.files().join("new").exists());
    assert_eq!(f.mirror.status().unwrap().files, 1);
}

#[test]
fn content_is_verified_before_anything_moves() {
    let mut f = Fixture::new();
    f.remote_write("a.txt", "one\n");
    f.remote_write("b.txt", "two\n");
    let manifest = f.manifest();
    // Bytes that do not match the hash the workspace reported.
    assert!(f.mirror.stage("a.txt", b"tampered", 8, &etag(b"one\n")).is_err());
    assert!(f.mirror.stage("a.txt", b"one\n", 4, "not-a-hash").is_err());
    f.mirror.stage("a.txt", b"one\n", 4, &etag(b"one\n")).unwrap();
    // One file was never read: the publish is refused whole.
    let etags: BTreeMap<String, String> = [("a.txt".to_string(), etag(b"one\n"))].into();
    assert!(f.mirror.publish(&manifest, &etags).is_err());
    assert_eq!(std::fs::read_dir(f.files()).unwrap().count(), 0, "not even the file that was ready");
    // A staged file that was altered afterwards is refused too.
    f.mirror.stage("b.txt", b"two\n", 4, &etag(b"two\n")).unwrap();
    let staged = f.mirror.staged("b.txt", &etag(b"two\n"));
    std::fs::write(&staged, b"swapped").unwrap();
    let etags: BTreeMap<String, String> = [("a.txt".to_string(), etag(b"one\n")), ("b.txt".to_string(), etag(b"two\n"))].into();
    assert!(f.mirror.publish(&manifest, &etags).is_err());
    assert_eq!(std::fs::read_dir(f.files()).unwrap().count(), 0);
    assert_eq!(f.mirror.status().unwrap().revision, None);
}

#[test]
fn a_publish_that_died_is_reconciled_once_and_exempts_nothing_from_the_divergence_check() {
    let mut f = Fixture::new();
    for path in ["moved.txt", "unmoved.txt", "edited-since.txt", "old.txt"] {
        f.remote_write(path, "v1\n");
    }
    f.sync().unwrap();
    for path in ["moved.txt", "unmoved.txt", "edited-since.txt"] {
        f.remote_write(path, "v2\n");
    }
    f.remote.remove("old.txt");

    // The app died mid-publish: the journal is written, one file is in
    // place, one removal is done, the record still describes the old revision.
    let dir = f.home.join("cloud-mirrors/org-1/workspace-1");
    let write = |version: &str| Write { etag: etag(b"v2\n"), version: version.into() };
    let journal = Journal {
        manifest_id: f.manifest().manifest_id,
        writes: [("moved.txt", "v2"), ("unmoved.txt", "v2"), ("edited-since.txt", "v2")].into_iter().map(|(path, version)| (path.to_string(), write(version))).collect(),
        deletes: ["old.txt".to_string()].into(),
    };
    std::fs::write(dir.join("journal.json"), serde_json::to_vec(&journal).unwrap()).unwrap();
    f.write_local("moved.txt", "v2\n");
    std::fs::remove_file(f.files().join("old.txt")).unwrap();
    // And the person edited a file the dead publish had not reached yet.
    f.write_local("edited-since.txt", "my edit\n");

    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert!(!dir.join("journal.json").exists(), "consumed once");
    // The file that did arrive is adopted, not fetched again and not a conflict.
    assert_eq!(plan.fetch, ["unmoved.txt"]);
    assert_eq!(plan.unchanged, 1);
    // The local edit is a divergence: being in the journal exempts nothing.
    assert_eq!(reasons(&plan.diverged), [("edited-since.txt", "modified")]);
    assert_eq!(f.sync().unwrap().written, 0);
    assert_eq!(f.local("edited-since.txt").as_deref(), Some("my edit\n"));

    f.mirror.resolve(&f.manifest(), Resolution::Discard).unwrap();
    f.sync().unwrap();
    assert_eq!(f.local("edited-since.txt").as_deref(), Some("v2\n"));
    assert_eq!(f.local("unmoved.txt").as_deref(), Some("v2\n"));
    assert_eq!(f.local("old.txt"), None);
    assert!(f.mirror.plan(&f.manifest()).unwrap().up_to_date);
}

#[test]
fn a_publish_that_fails_part_way_records_what_it_did_and_leaves_no_journal() {
    let mut f = Fixture::new();
    f.remote_write("a.txt", "v1\n");
    f.remote_write("z/late.txt", "v1\n");
    f.sync().unwrap();
    f.remote_write("a.txt", "v2\n");
    f.remote_write("z/late.txt", "v2\n");
    // The second file cannot be written: a folder took its place between
    // the plan and the publish.
    let manifest = f.manifest();
    let plan = f.mirror.plan(&manifest).unwrap();
    assert_eq!(plan.fetch, ["a.txt", "z/late.txt"]);
    let mut etags = BTreeMap::new();
    for path in &plan.fetch {
        f.mirror.stage(path, b"v2\n", 3, &etag(b"v2\n")).unwrap();
        etags.insert(path.clone(), etag(b"v2\n"));
    }
    let error = {
        // Divergence is checked before the journal; make the failure happen after it.
        let late = f.files().join("z/late.txt");
        let record = f.mirror.working_record().unwrap();
        assert!(record.owned.contains_key("z/late.txt"));
        // Same content and signature until the rename step, then a folder: simulate by
        // making the target's parent unwritable instead.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(late.parent().unwrap(), std::fs::Permissions::from_mode(0o555)).unwrap();
        }
        let error = f.mirror.publish(&manifest, &etags);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(late.parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        error
    };
    #[cfg(unix)]
    {
        assert!(error.is_err());
        let dir = f.home.join("cloud-mirrors/org-1/workspace-1");
        assert!(!dir.join("journal.json").exists(), "a failed publish leaves no journal behind");
        assert_eq!(f.local("a.txt").as_deref(), Some("v2\n"));
        assert_eq!(f.local("z/late.txt").as_deref(), Some("v1\n"));
        // What moved is recorded as moved: only the other file is still to fetch.
        let plan = f.mirror.plan(&f.manifest()).unwrap();
        assert_eq!((plan.fetch.clone(), plan.unchanged, plan.diverged_total), (vec!["z/late.txt".to_string()], 1, 0));
        // A local edit to the file that failed is still protected.
        f.write_local("z/late.txt", "my edit\n");
        assert_eq!(reasons(&f.sync().unwrap().diverged), [("z/late.txt", "modified")]);
        assert_eq!(f.local("z/late.txt").as_deref(), Some("my edit\n"));
    }
    let _ = error;
}

#[test]
fn a_local_change_stops_the_sync_and_is_never_overwritten() {
    let mut f = Fixture::new();
    for path in ["edited.txt", "deleted.txt", "kept.txt", "touched.txt"] {
        f.remote_write(path, "from the workspace\n");
    }
    f.sync().unwrap();
    assert_eq!(f.mirror.check().unwrap(), (Vec::new(), 0));

    f.write_local("edited.txt", "my local edit\n");
    std::fs::remove_file(f.files().join("deleted.txt")).unwrap();
    // Rewritten with the same content (an editor's save): not a change.
    std::thread::sleep(std::time::Duration::from_millis(20));
    f.write_local("touched.txt", "from the workspace\n");
    // A local file where the workspace will add one.
    f.write_local("incoming.txt", "mine\n");

    let (diverged, total) = f.mirror.check().unwrap();
    assert_eq!(total, 2);
    assert_eq!(reasons(&diverged), [("deleted.txt", "deleted"), ("edited.txt", "modified")]);

    // The workspace moves on, including on the files changed here.
    f.remote_write("edited.txt", "workspace v2\n");
    f.remote_write("kept.txt", "workspace v2\n");
    f.remote_write("incoming.txt", "workspace's\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(reasons(&plan.diverged), [("deleted.txt", "deleted"), ("edited.txt", "modified"), ("incoming.txt", "in-the-way")]);
    assert!(!plan.up_to_date);

    let published = f.sync().unwrap();
    assert_eq!((published.written, published.removed, published.diverged_total), (0, 0, 3));
    // Nothing was written at all: not the divergent files, not the clean one.
    assert_eq!(f.local("edited.txt").as_deref(), Some("my local edit\n"));
    assert_eq!(f.local("incoming.txt").as_deref(), Some("mine\n"));
    assert_eq!(f.local("deleted.txt"), None);
    assert_eq!(f.local("kept.txt").as_deref(), Some("from the workspace\n"));
    assert_ne!(f.mirror.status().unwrap().revision.unwrap().manifest_id, f.manifest().manifest_id, "the last successful revision is still the old one");
}

#[test]
fn discard_replaces_exactly_the_divergent_paths_and_export_keeps_the_local_versions() {
    let mut f = Fixture::new();
    f.remote_write("edited.txt", "v1\n");
    f.remote_write("deleted.txt", "v1\n");
    f.remote_write("dropped.txt", "v1\n");
    f.sync().unwrap();
    f.write_local("edited.txt", "my local edit\n");
    std::fs::remove_file(f.files().join("deleted.txt")).unwrap();
    f.write_local("dropped.txt", "my edit of a file the workspace removed\n");
    f.remote.remove("dropped.txt");
    assert_eq!(f.sync().unwrap().diverged_total, 3);

    let resolved = f.mirror.resolve(&f.manifest(), Resolution::Export).unwrap();
    assert_eq!(resolved.paths, 3);
    let exported = PathBuf::from(resolved.exported_to.unwrap());
    assert!(exported.starts_with(f.home.join("cloud-mirrors/org-1/workspace-1/exports")));
    assert_eq!(std::fs::read_to_string(exported.join("edited.txt")).unwrap(), "my local edit\n");
    assert_eq!(std::fs::read_to_string(exported.join("dropped.txt")).unwrap(), "my edit of a file the workspace removed\n");
    assert!(!exported.join("deleted.txt").exists(), "there was no local version to keep");

    // A change made after the answer was not part of it.
    f.remote_write("later.txt", "v1\n");
    f.write_local("later.txt", "mine, made after resolving\n");
    let blocked = f.sync().unwrap();
    assert_eq!(reasons(&blocked.diverged), [("later.txt", "in-the-way")]);
    assert_eq!(f.local("edited.txt").as_deref(), Some("my local edit\n"), "still nothing written");

    assert_eq!(f.mirror.resolve(&f.manifest(), Resolution::Discard).unwrap(), Resolved { paths: 1, exported_to: None });
    let published = f.sync().unwrap();
    assert_eq!(published.diverged_total, 0);
    assert_eq!(f.local("edited.txt").as_deref(), Some("v1\n"));
    assert_eq!(f.local("deleted.txt").as_deref(), Some("v1\n"));
    assert_eq!(f.local("later.txt").as_deref(), Some("v1\n"));
    assert_eq!(f.local("dropped.txt"), None);
    assert!(f.mirror.plan(&f.manifest()).unwrap().up_to_date);
    // The exports are the person's: a later sync never touches them.
    assert_eq!(std::fs::read_to_string(exported.join("edited.txt")).unwrap(), "my local edit\n");
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_in_the_mirror_never_redirects_a_write() {
    let mut f = Fixture::new();
    let outside = f.home.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("victim.txt"), "untouched\n").unwrap();

    // A folder of the mirror replaced by a link to somewhere else.
    std::os::unix::fs::symlink(&outside, f.files().join("src")).unwrap();
    f.remote_write("src/victim.txt", "overwritten?\n");
    f.remote_write("src/new.txt", "planted?\n");
    assert!(f.mirror.plan(&f.manifest()).unwrap_err().to_string().contains("symbolic link"));
    assert!(f.sync().is_err());
    assert_eq!(std::fs::read_to_string(outside.join("victim.txt")).unwrap(), "untouched\n");
    assert!(!outside.join("new.txt").exists());
    std::fs::remove_file(f.files().join("src")).unwrap();

    // A link where a file belongs is a local change, and discarding it
    // replaces the link itself, never what it points at.
    f.remote = BTreeMap::new();
    f.remote_write("link.txt", "from the workspace\n");
    std::os::unix::fs::symlink(outside.join("victim.txt"), f.files().join("link.txt")).unwrap();
    assert_eq!(reasons(&f.sync().unwrap().diverged), [("link.txt", "in-the-way")]);
    f.mirror.resolve(&f.manifest(), Resolution::Export).unwrap();
    f.sync().unwrap();
    assert!(std::fs::symlink_metadata(f.files().join("link.txt")).unwrap().is_file());
    assert_eq!(f.local("link.txt").as_deref(), Some("from the workspace\n"));
    assert_eq!(std::fs::read_to_string(outside.join("victim.txt")).unwrap(), "untouched\n");

    // A file the mirror wrote, later replaced by a link.
    std::fs::remove_file(f.files().join("link.txt")).unwrap();
    std::os::unix::fs::symlink(outside.join("victim.txt"), f.files().join("link.txt")).unwrap();
    assert_eq!(reasons(&f.mirror.check().unwrap().0), [("link.txt", "replaced")]);
}

#[test]
fn secrets_git_metadata_and_paths_that_leave_the_mirror_are_refused() {
    let mut f = Fixture::new();
    // Staging one is refused even with the right size and hash.
    for path in [".env", "deploy/prod.pem", ".aws/credentials", ".git/config", "sub/.git/HEAD", ".claude/settings.json", ".mcp.json", ".vscode/tasks.json", ".claude/.credentials.json"] {
        assert!(f.mirror.stage(path, b"x", 1, &etag(b"x")).is_err(), "{path}");
    }
    for path in ["../outside.txt", "/etc/passwd", "a/../../b", "a//b", "./a", "a\\b", "", "a/./b"] {
        assert!(f.mirror.stage(path, b"x", 1, &etag(b"x")).is_err(), "{path:?}");
    }
    let staging = f.home.join("cloud-mirrors/org-1/workspace-1/staging");
    assert!(!staging.exists() || std::fs::read_dir(&staging).unwrap().count() == 0);

    // A manifest from a runtime with older rules, or a hostile one: each such
    // entry is left out and counted, and the rest of the mirror still works.
    f.remote_write("app.ts", "x\n");
    f.remote_write(".env", "TOKEN=1\n");
    f.remote_write(".claude/settings.json", "{}\n");
    f.remote_write(".vscode/tasks.json", "{}\n");
    let mut manifest = f.manifest();
    for path in ["../outside.txt", "/etc/passwd", ".git/config", "a\\b", "a//b"] {
        manifest.entries.push(Entry { path: path.into(), size: 1, version: "v1".into(), executable: false });
    }
    let plan = f.mirror.plan(&manifest).unwrap();
    assert_eq!(plan.fetch, ["app.ts"]);
    assert_eq!(plan.refused, Refused { secret: 1, tool_config: 2, invalid: 5, ..Refused::default() });
    f.sync().unwrap();
    assert_eq!(f.local(".env"), None);
    assert!(!f.files().join(".claude").exists() && !f.files().join(".vscode").exists());
    assert!(!f.home.join("outside.txt").exists());

    let mut truncated = f.manifest();
    truncated.truncated = true;
    assert!(f.mirror.plan(&truncated).unwrap_err().to_string().contains("more files"));
    let mut twice = f.manifest();
    twice.entries.push(twice.entries[0].clone());
    assert!(f.mirror.plan(&twice).unwrap_err().to_string().contains("twice"));
}

#[test]
fn an_embedded_git_directory_is_never_written_under_any_name() {
    let mut f = Fixture::new();
    // The reproduced attack: a bare repository as ordinary files, whose
    // config makes Git run a command.
    f.remote_write("pkg/HEAD", "ref: refs/heads/main\n");
    f.remote_write("pkg/config", "[core]\n\tfsmonitor = touch /tmp/owned\n");
    f.remote_write("pkg/objects/x", "x\n");
    f.remote_write("pkg/refs/x", "x\n");
    f.remote_write("pkg/README", "looks harmless\n");
    f.remote_write("Deep/Er/head", "x\n");
    f.remote_write("Deep/Er/OBJECTS/pack/p", "x\n");
    f.remote_write("Deep/Er/Refs/heads/main", "x\n");
    f.remote_write("src/objects/a.ts", "x\n");
    f.remote_write("docs/HEAD.md", "x\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.fetch, ["docs/HEAD.md", "src/objects/a.ts"]);
    assert_eq!(plan.refused.git_directory, 8);
    f.sync().unwrap();
    assert!(!f.files().join("pkg").exists() && !f.files().join("Deep").exists());

    // It cannot be assembled over two syncs either: once the folder would
    // be a Git directory, everything in it goes, including what was there.
    let mut g = Fixture::new();
    g.remote_write("lib/objects/x", "x\n");
    g.remote_write("lib/refs/x", "x\n");
    g.remote_write("lib/config", "[core]\n\tfsmonitor = touch /tmp/owned\n");
    g.sync().unwrap();
    assert!(g.files().join("lib/config").exists(), "not a Git directory yet");
    g.remote_write("lib/HEAD", "ref: refs/heads/main\n");
    let published = g.sync().unwrap();
    assert_eq!((published.written, published.removed), (0, 3));
    assert!(!g.files().join("lib").exists());
    // Git agrees there is no repository there for it to obey.
    assert!(!crate::git::is_repo(&g.files()));
}

#[cfg(target_os = "macos")]
#[test]
fn every_mirrored_file_is_quarantined_and_none_is_executable() {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.remote.insert("Install.command".into(), (b"#!/bin/sh\necho hi\n".to_vec(), true, 1));
    f.remote.insert("Tool.app/Contents/MacOS/Tool".into(), (b"\xcf\xfa\xed\xfe".to_vec(), true, 1));
    f.remote_write("README.md", "x\n");
    f.sync().unwrap();
    for path in ["Install.command", "Tool.app/Contents/MacOS/Tool", "README.md"] {
        let file = f.files().join(path);
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o111, 0, "{path} is not executable");
        let name = std::ffi::CString::new("com.apple.quarantine").unwrap();
        let c_path = std::ffi::CString::new(file.as_os_str().as_bytes()).unwrap();
        let mut value = [0u8; 128];
        // SAFETY: valid C strings and a buffer of the length given.
        let read = unsafe { libc::getxattr(c_path.as_ptr(), name.as_ptr(), value.as_mut_ptr().cast(), value.len(), 0, 0) };
        assert!(read > 0, "{path} is quarantined");
        let text = String::from_utf8_lossy(&value[..read as usize]).into_owned();
        assert!(text.starts_with("0081;") && text.ends_with(";TerminalX;"), "{text}");
    }
    // A rewrite keeps both.
    f.remote.insert("Install.command".into(), (b"#!/bin/sh\necho again\n".to_vec(), true, 2));
    f.sync().unwrap();
    assert_eq!(std::fs::metadata(f.files().join("Install.command")).unwrap().permissions().mode() & 0o777, 0o644);
}

#[test]
fn a_mirror_is_bounded_on_this_side_whatever_the_workspace_says() {
    let mut f = Fixture::new();
    // A size that lies: the manifest says 3 bytes, the read brings more.
    f.remote_write("a.txt", "abc");
    let big = vec![b'x'; 4096];
    assert!(f.mirror.stage("a.txt", &big, 3, &etag(&big)).unwrap_err().to_string().contains("size"));
    // Or the staged file is swapped for a larger one with a matching hash.
    f.mirror.stage("a.txt", b"abc", 3, &etag(b"abc")).unwrap();
    let manifest = f.manifest();
    std::fs::write(f.mirror.staged("a.txt", &etag(b"abc")), &big).unwrap();
    let etags: BTreeMap<String, String> = [("a.txt".to_string(), etag(b"abc"))].into();
    assert!(f.mirror.publish(&manifest, &etags).unwrap_err().to_string().contains("size"));
    assert_eq!(f.local("a.txt"), None);

    // More files, or more bytes, than a mirror holds.
    let entry = |path: String, size: u64| Entry { path, size, version: "v1".into(), executable: false };
    let many = Manifest { manifest_id: "m".into(), repositories: Vec::new(), entries: (0..=MAX_FILES).map(|index| entry(format!("f{index}"), 1)).collect(), truncated: false };
    assert!(f.mirror.plan(&many).unwrap_err().to_string().contains("more files"));
    let per_file = 32 * 1024 * 1024;
    let heavy = Manifest { manifest_id: "m".into(), repositories: Vec::new(), entries: (0..=(MAX_TOTAL_BYTES / per_file)).map(|index| entry(format!("f{index}"), per_file)).collect(), truncated: false };
    assert!(f.mirror.plan(&heavy).unwrap_err().to_string().contains("larger than a mirror holds"));
    let huge = Manifest { manifest_id: "m".into(), repositories: Vec::new(), entries: vec![entry("one".into(), per_file + 1)], truncated: false };
    assert!(f.mirror.plan(&huge).is_err());

    // Too deep, a name too long for one folder entry, a path too long for this disk.
    let deep = (0..40).map(|index| format!("d{index}")).collect::<Vec<_>>().join("/");
    let long_name = "n".repeat(300);
    let long_path = (0..8).map(|_| "p".repeat(200)).collect::<Vec<_>>().join("/");
    let odd = Manifest {
        manifest_id: "m".into(),
        repositories: Vec::new(),
        entries: vec![entry(deep, 1), entry(long_name, 1), entry(long_path, 1), entry("fine.txt".into(), 1)],
        truncated: false,
    };
    let plan = f.mirror.plan(&odd).unwrap();
    assert_eq!((plan.fetch.clone(), plan.refused.too_long), (vec!["fine.txt".to_string()], 3));

    // What an abandoned sync staged does not pile up: the next plan starts clean.
    f.mirror.stage("fine.txt", b"x", 1, &etag(b"x")).unwrap();
    assert_eq!(std::fs::read_dir(f.home.join("cloud-mirrors/org-1/workspace-1/staging")).unwrap().count(), 1);
    f.mirror.plan(&odd).unwrap();
    assert!(!f.home.join("cloud-mirrors/org-1/workspace-1/staging").exists());
}

#[test]
fn names_that_are_one_file_on_this_disk_are_settled_before_anything_is_written() {
    let mut f = Fixture::new();
    // The same name in two Unicode forms (composed and decomposed é).
    f.remote_write("caf\u{e9}.txt", "composed\n");
    f.remote_write("cafe\u{301}.txt", "decomposed\n");
    // A file where another entry needs a folder.
    f.remote_write("data", "a file\n");
    f.remote_write("data/inner.txt", "needs data to be a folder\n");
    f.remote_write("plain.txt", "x\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.refused.collision, 2, "one of each pair is refused, on every disk");
    assert_eq!(plan.fetch.len(), 3);
    assert!(plan.fetch.contains(&"data".to_string()) && !plan.fetch.contains(&"data/inner.txt".to_string()));
    f.sync().unwrap();
    // Stable: the mirror never sees its own file as a conflict.
    let again = f.mirror.plan(&f.manifest()).unwrap();
    assert!(again.up_to_date, "{again:?}");
    assert_eq!(f.mirror.check().unwrap().1, 0);

    if f.mirror.case_insensitive() {
        // A file `a` beside a folder `A/`.
        let mut g = Fixture::new();
        g.remote_write("A/inner.txt", "x\n");
        g.remote_write("a", "x\n");
        let plan = g.mirror.plan(&g.manifest()).unwrap();
        assert_eq!((plan.fetch.clone(), plan.refused.collision), (vec!["A/inner.txt".to_string()], 1));
        g.sync().unwrap();
        assert!(g.mirror.plan(&g.manifest()).unwrap().up_to_date);

        // A rename that only changes case is the workspace's change, not a local file in the way.
        let mut h = Fixture::new();
        h.remote_write("Readme.md", "v1\n");
        h.sync().unwrap();
        h.remote.remove("Readme.md");
        h.remote_write("readme.md", "v2\n");
        let plan = h.mirror.plan(&h.manifest()).unwrap();
        assert_eq!((plan.diverged_total, plan.fetch.clone(), plan.remove), (0, vec!["readme.md".to_string()], 1));
        h.sync().unwrap();
        assert_eq!(h.local("readme.md").as_deref(), Some("v2\n"));
        assert!(h.mirror.plan(&h.manifest()).unwrap().up_to_date);
        assert_eq!(std::fs::read_dir(h.files()).unwrap().count(), 1);
    }
}

#[cfg(unix)]
#[test]
fn none_of_the_mirrors_own_directories_may_be_a_link() {
    let dir = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(dir.path()).unwrap();
    let elsewhere = home.join("elsewhere");
    std::fs::create_dir_all(elsewhere.join("precious")).unwrap();
    std::fs::write(elsewhere.join("precious/file.txt"), "keep\n").unwrap();
    let manifest = Manifest { manifest_id: "m".into(), repositories: Vec::new(), entries: vec![Entry { path: "a.txt".into(), size: 1, version: "v1".into(), executable: false }], truncated: false };

    // `files/` replaced by a link after the mirror was made.
    let mirror = Mirror::at(&home, "org-1", "workspace-1").unwrap();
    mirror.enable().unwrap();
    let files = home.join("cloud-mirrors/org-1/workspace-1/files");
    std::fs::remove_dir(&files).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("precious"), &files).unwrap();
    for result in [mirror.plan(&manifest).map(|_| ()), mirror.stage("a.txt", b"x", 1, &etag(b"x")), mirror.publish(&manifest, &BTreeMap::new()).map(|_| ()), mirror.status().map(|_| ())] {
        assert!(result.unwrap_err().to_string().contains("symbolic link"));
    }
    // "Remove local copy" does not follow it.
    assert!(mirror.disable(true).is_err());
    assert_eq!(std::fs::read_to_string(elsewhere.join("precious/file.txt")).unwrap(), "keep\n");

    // The workspace's directory, the organization's, and `cloud-mirrors` itself.
    for link in ["cloud-mirrors/org-2/workspace-2", "cloud-mirrors/org-3", "cloud-mirrors"] {
        let home = std::fs::canonicalize(tempfile::tempdir().unwrap().keep()).unwrap();
        let at = home.join(link);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("precious"), &at).unwrap();
        let (org, workspace) = if link.contains("org-2") { ("org-2", "workspace-2") } else if link.contains("org-3") { ("org-3", "w") } else { ("o", "w") };
        let mirror = Mirror::at(&home, org, workspace).unwrap();
        assert!(mirror.enable().unwrap_err().to_string().contains("symbolic link"), "{link}");
        assert_eq!(std::fs::read_dir(elsewhere.join("precious")).unwrap().count(), 1, "{link}: nothing written through the link");
    }
}

#[test]
fn a_mirror_is_never_a_project_or_an_agents_working_directory() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.files().join("src")).unwrap();
    assert!(holds(&f.home, &f.files()));
    assert!(holds(&f.home, &f.files().join("src")));
    assert!(holds(&f.home, &f.home.join("cloud-mirrors")));
    assert!(!holds(&f.home, &f.home));
    assert!(!holds(&f.home, &f.home.join("cloud-mirrors-of-mine")));
    // Through a link to it, too.
    #[cfg(unix)]
    {
        let link = f.home.join("shortcut");
        std::os::unix::fs::symlink(f.files(), &link).unwrap();
        assert!(holds(&f.home, &link));
    }
}

#[test]
fn a_mirror_belongs_to_one_workspace_and_is_off_until_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(dir.path()).unwrap();
    for (org, workspace) in [("..", "w"), ("o", "../w"), ("o/x", "w"), ("", "w"), ("o", "w w"), ("-o", "w")] {
        assert!(Mirror::at(&home, org, workspace).is_err(), "{org:?} {workspace:?}");
    }
    let mirror = Mirror::at(&home, "org-1", "workspace-1").unwrap();
    // Asking about a mirror that was never turned on creates nothing.
    assert_eq!(mirror.status().unwrap(), Status { enabled: false, root: home.join("cloud-mirrors/org-1/workspace-1/files").to_string_lossy().into_owned(), revision: None, files: 0 });
    assert!(!home.join("cloud-mirrors").exists());
    let empty = Manifest { manifest_id: "m".into(), repositories: Vec::new(), entries: Vec::new(), truncated: false };
    assert!(mirror.plan(&empty).is_err());
    assert!(mirror.stage("a.txt", b"x", 1, &etag(b"x")).is_err());
    assert!(mirror.publish(&empty, &BTreeMap::new()).is_err());
    assert!(!home.join("cloud-mirrors").exists());

    // A record of another workspace in this directory is refused.
    mirror.enable().unwrap();
    let record = home.join("cloud-mirrors/org-1/workspace-1/mirror.json");
    let other = std::fs::read_to_string(&record).unwrap().replace("workspace-1", "workspace-2");
    std::fs::write(&record, other).unwrap();
    assert!(mirror.status().unwrap_err().to_string().contains("another workspace"));
}

#[test]
fn turning_it_off_keeps_the_files_unless_asked_and_always_keeps_exports() {
    let mut f = Fixture::new();
    f.remote_write("a.txt", "v1\n");
    f.sync().unwrap();
    f.write_local("a.txt", "mine\n");
    f.mirror.resolve(&f.manifest(), Resolution::Export).unwrap();
    let dir = f.home.join("cloud-mirrors/org-1/workspace-1");

    let off = f.mirror.disable(false).unwrap();
    assert!(!off.enabled);
    assert_eq!(f.local("a.txt").as_deref(), Some("mine\n"));
    assert!(f.mirror.plan(&f.manifest()).is_err(), "off: nothing syncs");
    // On again: the same record, so the local edit is still a divergence.
    f.mirror.enable().unwrap();
    assert_eq!(f.mirror.status().unwrap().files, 1);

    let removed = f.mirror.disable(true).unwrap();
    assert_eq!((removed.enabled, removed.files, removed.revision), (false, 0, None));
    assert!(!dir.join("files").exists() && !dir.join("mirror.json").exists());
    assert_eq!(std::fs::read_dir(dir.join("exports")).unwrap().count(), 1);
}

#[test]
fn the_app_refuses_a_mirror_as_a_project_with_the_reason() {
    let _home = crate::store::temp_home();
    let home = crate::store::root().unwrap();
    let mirror = Mirror::at(&home, "org-1", "workspace-1").unwrap();
    mirror.enable().unwrap();
    let files = std::path::PathBuf::from(mirror.status().unwrap().root);
    std::fs::create_dir_all(files.join("src")).unwrap();
    // The project picker and the CLI both add a project this way.
    for path in [files.clone(), files.join("src")] {
        let refused = crate::store::projects::add(&path.to_string_lossy()).unwrap_err().to_string();
        assert!(refused.contains("local mirror of a cloud workspace") && refused.contains("cannot be opened as a project"), "{refused}");
    }
    // An agent's working directory goes through the same check.
    let canonical = std::fs::canonicalize(&files).unwrap();
    assert!(crate::store::projects::refuse_mirror(&canonical.to_string_lossy()).is_err());
    assert!(crate::store::projects::list().unwrap().0.is_empty());
    // Any other folder is a project as before.
    let other = tempfile::tempdir().unwrap();
    assert!(crate::store::projects::add(&other.path().to_string_lossy()).is_ok());
}

#[test]
fn losing_access_removes_what_the_mirror_wrote_and_nothing_else() {
    let mut f = Fixture::new();
    f.remote_write("a.txt", "v1\n");
    f.remote_write("dir/b.txt", "v1\n");
    f.remote_write("only/c.txt", "v1\n");
    f.sync().unwrap();
    f.write_local("dir/mine.txt", "mine\n");
    f.write_local("a.txt", "edited\n");
    f.mirror.resolve(&f.manifest(), Resolution::Export).unwrap();
    assert_eq!(existing(&f.home), [("org-1".to_string(), "workspace-1".to_string())]);

    assert_eq!(f.mirror.purge().unwrap(), 3);
    assert_eq!(f.local("a.txt"), None);
    assert_eq!(f.local("dir/b.txt"), None);
    assert!(!f.files().join("only").exists());
    // The person's own file and their exports are not the mirror's to remove.
    assert_eq!(f.local("dir/mine.txt").as_deref(), Some("mine\n"));
    let dir = f.home.join("cloud-mirrors/org-1/workspace-1");
    // The edited file was the person's work on it: kept aside, not deleted.
    let exports: Vec<_> = std::fs::read_dir(dir.join("exports")).unwrap().filter_map(Result::ok).map(|entry| entry.path()).collect();
    assert!(exports.iter().any(|export| std::fs::read_to_string(export.join("a.txt")).is_ok_and(|text| text == "edited\n")));
    assert!(exports.iter().all(|export| !export.join("dir/b.txt").exists()), "an untouched copy is not exported");
    assert!(!dir.join("mirror.json").exists());
    assert!(!f.mirror.status().unwrap().enabled);
    assert!(existing(&f.home).is_empty());
    assert_eq!(f.mirror.purge().unwrap(), 0, "nothing left to remove");

    // With nothing of the person's in it, the folder goes entirely.
    let mut g = Fixture::new();
    g.remote_write("a.txt", "v1\n");
    g.sync().unwrap();
    g.mirror.purge().unwrap();
    assert!(!g.home.join("cloud-mirrors/org-1/workspace-1").exists());
}

// ---- Review 2: bypasses of the Git-directory rule, on a real disk ----------
//
// These run against a temporary directory on this machine's own filesystem
// (APFS on the Macs this ships to), so what is asserted is what the disk
// does, not what the rules assume it does.

/// Whether Git, run inside `dir`, takes anything there for a repository.
fn git_sees_a_repository(dir: &Path) -> bool {
    dir.is_dir() && crate::git::is_repo(dir)
}

#[test]
fn a_git_directory_split_across_two_folders_is_never_written() {
    let mut f = Fixture::new();
    // One folder holds HEAD and a pointer; its sibling holds the rest.
    f.remote_write("wt/HEAD", "ref: refs/heads/main\n");
    f.remote_write("wt/commondir", "../common\n");
    f.remote_write("wt/config.worktree", "[core]\n\tfsmonitor = touch /tmp/owned\n");
    f.remote_write("common/objects/x", "x\n");
    f.remote_write("common/refs/x", "x\n");
    f.remote_write("common/config", "[extensions]\n\tworktreeConfig = true\n");
    f.remote_write("src/a.ts", "x\n");
    // A pointer on its own, anywhere, is refused too.
    f.remote_write("docs/gitdir", "../common\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.refused.git_directory, 4, "wt/HEAD, wt/commondir, wt/config.worktree, docs/gitdir");
    assert_eq!(plan.fetch, ["common/config", "common/objects/x", "common/refs/x", "src/a.ts"]);
    f.sync().unwrap();
    assert!(!f.files().join("wt").exists());
    assert!(!f.files().join("docs").exists());
    // What is left of the pair is not a repository to Git, from either folder.
    assert!(!git_sees_a_repository(&f.files().join("common")));
    assert!(!git_sees_a_repository(&f.files()));
}

#[test]
fn names_the_disk_folds_do_not_get_past_the_rules() {
    let mut f = Fixture::new();
    // The long s (U+017F) and the Kelvin sign (U+212A): on APFS these are
    // `objects`, `refs`, `.vscode/tasks.json`, `.mcp.json`, `.husky`.
    f.remote_write("pkg/HEAD", "ref: refs/heads/main\n");
    f.remote_write("pkg/config", "[core]\n\tfsmonitor = touch /tmp/owned\n");
    f.remote_write("pkg/object\u{17f}/x", "x\n");
    f.remote_write("pkg/ref\u{17f}/x", "x\n");
    f.remote_write(".v\u{17f}code/ta\u{17f}k\u{17f}.json", "{}\n");
    f.remote_write(".mcp.j\u{17f}on", "{}\n");
    f.remote_write(".hu\u{17f}\u{212a}y/pre-commit", "#!/bin/sh\n");
    f.remote_write("src/a.ts", "x\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.fetch, ["src/a.ts"]);
    assert_eq!((plan.refused.git_directory, plan.refused.tool_config), (4, 3));
    f.sync().unwrap();
    assert_eq!(std::fs::read_dir(f.files()).unwrap().count(), 1, "only src/");
    assert!(!git_sees_a_repository(&f.files().join("pkg")));
}

#[test]
fn one_folder_under_three_spellings_is_one_folder() {
    let mut f = Fixture::new();
    f.remote_write("pkg/HEAD", "ref: refs/heads/main\n");
    f.remote_write("PKG/objects/x", "x\n");
    f.remote_write("Pkg/refs/x", "x\n");
    f.remote_write("Pkg/config", "[core]\n\tfsmonitor = touch /tmp/owned\n");
    f.remote_write("src/a.ts", "x\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.fetch, ["src/a.ts"]);
    assert_eq!(plan.refused.git_directory, 4);
    f.sync().unwrap();
    assert!(!f.files().join("pkg").exists() && !f.files().join("PKG").exists());
}

#[test]
fn the_disk_has_the_last_word_after_a_publish() {
    let mut f = Fixture::new();
    // The names alone do not make a Git directory: the manifest has HEAD
    // and a config, in a folder that on THIS disk already holds `objects/`
    // and `refs/` (left by something else, under another spelling).
    std::fs::create_dir_all(f.files().join("PKG/objects")).unwrap();
    std::fs::create_dir_all(f.files().join("PKG/refs")).unwrap();
    f.write_local("PKG/objects/mine.txt", "the person's\n");
    f.remote_write("pkg/HEAD", "ref: refs/heads/main\n");
    f.remote_write("pkg/README.md", "looks harmless\n");
    f.remote_write("src/a.ts", "x\n");
    let folds = f.mirror.case_insensitive();
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.refused.git_directory, 0, "nothing in the manifest says Git directory");

    let published = f.sync().unwrap();
    if folds {
        // On a disk that folds case `pkg` IS `PKG`: HEAD landed beside
        // objects/ and refs/. The check of the disk takes it back.
        assert_eq!((published.written, published.taken_back), (3, 2));
        assert!(!f.files().join("PKG/HEAD").exists());
        assert!(!f.files().join("PKG/README.md").exists());
        assert!(!git_sees_a_repository(&f.files().join("PKG")));
        // The person's own file is not the mirror's to remove.
        assert_eq!(f.local("PKG/objects/mine.txt").as_deref(), Some("the person's\n"));
        assert_eq!(f.local("src/a.ts").as_deref(), Some("x\n"));
        // And it is not written again on the next sync.
        let plan = f.mirror.plan(&f.manifest()).unwrap();
        assert_eq!((plan.fetch.len(), plan.refused.on_disk), (0, 2));
        assert_eq!(f.sync().unwrap().written, 0);
        assert!(!f.files().join("PKG/HEAD").exists());
    } else {
        // A disk that keeps `pkg` and `PKG` apart: two folders, no Git directory.
        assert_eq!(published.taken_back, 0);
        assert!(!git_sees_a_repository(&f.files().join("pkg")));
    }
}

#[test]
fn an_edit_made_after_discard_is_a_new_divergence() {
    let mut f = Fixture::new();
    f.remote_write("a.txt", "v1\n");
    f.remote_write("b.txt", "v1\n");
    f.sync().unwrap();
    f.write_local("a.txt", "first edit\n");
    std::fs::remove_file(f.files().join("b.txt")).unwrap();
    f.remote_write("a.txt", "v2\n");
    assert_eq!(f.sync().unwrap().diverged_total, 2);
    f.mirror.resolve(&f.manifest(), Resolution::Discard).unwrap();

    // Before the next sync the person edits one again, and restores the other by hand.
    f.write_local("a.txt", "second edit, after discarding the first\n");
    f.write_local("b.txt", "written back by hand\n");
    let blocked = f.sync().unwrap();
    assert_eq!(reasons(&blocked.diverged), [("a.txt", "modified"), ("b.txt", "modified")]);
    assert_eq!(blocked.written, 0);
    assert_eq!(f.local("a.txt").as_deref(), Some("second edit, after discarding the first\n"));
    assert_eq!(f.local("b.txt").as_deref(), Some("written back by hand\n"));

    // Discarding what is there now does replace it.
    f.mirror.resolve(&f.manifest(), Resolution::Discard).unwrap();
    f.sync().unwrap();
    assert_eq!(f.local("a.txt").as_deref(), Some("v2\n"));
    assert_eq!(f.local("b.txt").as_deref(), Some("v1\n"));
}

#[test]
fn finders_bookkeeping_does_not_keep_a_removed_folder_alive() {
    let mut f = Fixture::new();
    f.remote_write("lib/objects/x", "x\n");
    f.remote_write("lib/refs/x", "x\n");
    f.remote_write("keep.txt", "x\n");
    f.sync().unwrap();
    // The person looked at the folders in Finder.
    f.write_local("lib/objects/.DS_Store", "finder\n");
    f.write_local("lib/refs/.DS_Store", "finder\n");
    f.write_local("lib/.DS_Store", "finder\n");
    f.remote.remove("lib/objects/x");
    f.remote.remove("lib/refs/x");
    f.sync().unwrap();
    assert!(!f.files().join("lib").exists(), "no empty objects/ and refs/ left for a later HEAD to complete");
    // A folder with something of the person's in it stays.
    let mut g = Fixture::new();
    g.remote_write("dir/a.txt", "x\n");
    g.sync().unwrap();
    g.write_local("dir/.DS_Store", "finder\n");
    g.write_local("dir/mine.txt", "mine\n");
    g.remote.remove("dir/a.txt");
    g.sync().unwrap();
    assert_eq!(g.local("dir/mine.txt").as_deref(), Some("mine\n"));
}

#[test]
fn names_that_fold_by_unicode_not_only_by_ascii_are_one_file() {
    let mut f = Fixture::new();
    if !f.mirror.case_insensitive() {
        return;
    }
    // The long s against `s`: one file on a disk that folds case.
    f.remote_write("sample.txt", "plain\n");
    f.remote_write("\u{17f}ample.txt", "long s\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!((plan.fetch.len(), plan.refused.collision), (1, 1));
    f.sync().unwrap();
    // The disk agrees: one file, and the mirror does not see its own as a conflict.
    assert_eq!(std::fs::read_dir(f.files()).unwrap().count(), 1);
    assert!(f.mirror.plan(&f.manifest()).unwrap().up_to_date);
    assert_eq!(f.mirror.check().unwrap().1, 0);
}

#[test]
fn a_mirror_made_under_another_account_is_removed_when_the_next_one_arrives() {
    let mut f = Fixture::new();
    f.remote_write("a.txt", "v1\n");
    f.sync().unwrap();
    // The first account to be seen owns what is there.
    assert_eq!(claim_owner(&f.home, "ada@example.com").unwrap(), 0);
    assert_eq!(claim_owner(&f.home, "ada@example.com").unwrap(), 0);
    assert_eq!(f.local("a.txt").as_deref(), Some("v1\n"));
    // The app was closed, and opens signed in as someone else.
    assert_eq!(claim_owner(&f.home, "bob@example.com").unwrap(), 1);
    assert_eq!(f.local("a.txt"), None);
    assert!(existing(&f.home).is_empty());
    // The owner is kept as a hash, not as the address.
    let owner = std::fs::read_to_string(f.home.join("cloud-mirrors/owner")).unwrap();
    assert!(!owner.contains("bob") && !owner.contains("example.com"));
    // Nothing to do when there are no mirrors at all.
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(claim_owner(empty.path(), "ada@example.com").unwrap(), 0);
    assert!(!empty.path().join("cloud-mirrors").exists());
}
