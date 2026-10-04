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
            self.mirror.stage(path, bytes, &etag(bytes))?;
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
        assert_eq!(mode("bin/run.sh"), 0o755);
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
    assert!(f.mirror.stage("a.txt", b"tampered", &etag(b"one\n")).is_err());
    assert!(f.mirror.stage("a.txt", b"one\n", "not-a-hash").is_err());
    f.mirror.stage("a.txt", b"one\n", &etag(b"one\n")).unwrap();
    // One file was never read: the publish is refused whole.
    let etags: BTreeMap<String, String> = [("a.txt".to_string(), etag(b"one\n"))].into();
    assert!(f.mirror.publish(&manifest, &etags).is_err());
    assert_eq!(std::fs::read_dir(f.files()).unwrap().count(), 0, "not even the file that was ready");
    // A staged file that was altered afterwards is refused too.
    f.mirror.stage("b.txt", b"two\n", &etag(b"two\n")).unwrap();
    let staged = f.mirror.staged("b.txt", &etag(b"two\n"));
    std::fs::write(&staged, b"swapped").unwrap();
    let etags: BTreeMap<String, String> = [("a.txt".to_string(), etag(b"one\n")), ("b.txt".to_string(), etag(b"two\n"))].into();
    assert!(f.mirror.publish(&manifest, &etags).is_err());
    assert_eq!(std::fs::read_dir(f.files()).unwrap().count(), 0);
    assert_eq!(f.mirror.status().unwrap().revision, None);
}

#[test]
fn an_interrupted_publish_is_finished_by_the_next_sync_not_called_a_conflict() {
    let mut f = Fixture::new();
    f.remote_write("a.txt", "one\n");
    f.remote_write("b.txt", "two\n");
    f.remote_write("old.txt", "old\n");
    f.sync().unwrap();
    f.remote_write("a.txt", "one v2\n");
    f.remote_write("b.txt", "two v2\n");
    f.remote.remove("old.txt");

    // The app died mid-publish: the journal is written, one file is already
    // in place, the record still describes the old revision.
    let dir = f.home.join("cloud-mirrors/org-1/workspace-1");
    let journal = Journal { manifest_id: f.manifest().manifest_id, paths: ["a.txt", "b.txt", "old.txt"].map(String::from).into() };
    std::fs::write(dir.join("journal.json"), serde_json::to_vec(&journal).unwrap()).unwrap();
    f.write_local("a.txt", "one v2\n");
    std::fs::remove_file(f.files().join("old.txt")).unwrap();

    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!(plan.diverged_total, 0, "the mirror's own half-done work is not a local edit");
    assert_eq!(plan.fetch, ["a.txt", "b.txt"]);
    let published = f.sync().unwrap();
    assert_eq!(published.diverged_total, 0);
    assert_eq!(f.local("a.txt").as_deref(), Some("one v2\n"));
    assert_eq!(f.local("b.txt").as_deref(), Some("two v2\n"));
    assert_eq!(f.local("old.txt"), None);
    assert!(!dir.join("journal.json").exists());
    assert!(f.mirror.plan(&f.manifest()).unwrap().up_to_date);
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
    // Staging a secret is refused even with the right hash.
    for path in [".env", "deploy/prod.pem", ".aws/credentials", ".git/config", "sub/.git/HEAD"] {
        assert!(f.mirror.stage(path, b"x", &etag(b"x")).is_err(), "{path}");
    }
    for path in ["../outside.txt", "/etc/passwd", "a/../../b", "a//b", "./a", "a\\b", "", "a/./b"] {
        assert!(f.mirror.stage(path, b"x", &etag(b"x")).is_err(), "{path:?}");
    }
    assert!(!f.home.join("cloud-mirrors/org-1/workspace-1/staging").exists() || std::fs::read_dir(f.home.join("cloud-mirrors/org-1/workspace-1/staging")).unwrap().count() == 0);

    // A manifest that lists a secret (a runtime with older rules): left out, counted.
    f.remote_write("app.ts", "x\n");
    f.remote_write(".env", "TOKEN=1\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    assert_eq!((plan.fetch.clone(), plan.refused), (vec!["app.ts".to_string()], 1));
    f.sync().unwrap();
    assert_eq!(f.local(".env"), None);

    // A manifest that names a path outside the workspace is broken: refused whole.
    for path in ["../outside.txt", "/etc/passwd", ".git/config", "a\\b"] {
        let mut manifest = f.manifest();
        manifest.entries.push(Entry { path: path.into(), size: 1, version: "v1".into(), executable: false });
        assert!(f.mirror.plan(&manifest).is_err(), "{path}");
    }
    let mut truncated = f.manifest();
    truncated.truncated = true;
    assert!(f.mirror.plan(&truncated).unwrap_err().to_string().contains("more files"));
    assert!(!f.home.join("outside.txt").exists());
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
    assert!(mirror.stage("a.txt", b"x", &etag(b"x")).is_err());
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
fn names_that_differ_only_by_case_are_one_file_on_a_disk_that_folds_case() {
    let mut f = Fixture::new();
    f.remote_write("Readme.md", "upper\n");
    f.remote_write("readme.md", "lower\n");
    let plan = f.mirror.plan(&f.manifest()).unwrap();
    if f.mirror.case_insensitive() {
        assert_eq!((plan.fetch.len(), plan.refused), (1, 1));
        f.sync().unwrap();
        // Stable: the next scan does not see its own file as a conflict.
        assert!(f.mirror.plan(&f.manifest()).unwrap().up_to_date);
    } else {
        assert_eq!((plan.fetch.len(), plan.refused), (2, 0));
    }
}
